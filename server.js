import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { Octokit } from "@octokit/rest";
import { extractSection } from "./utils/extractSection.js";
import { replaceSection } from "./utils/replaceSection.js";

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
const PORT = process.env.PORT || 3000;

const GITHUB_REPO = "appsmithorg/appsmith-docs";
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

app.get("/", (_, res) => res.send("✅ Slack doc bot running"));

app.post("/slack/fixdoc", async (req, res) => {
  const { text, user_name, response_url } = req.body;
  if (!text) return res.send("Please provide a path and issue.");

  res.status(200).send(`Thanks <@${user_name}>! Working on: ${text}`);
  setTimeout(() => handleFixdoc(text, user_name, response_url), 0);
});

async function handleFixdoc(text, username, response_url) {
  try {
    const spaceIndex = text.indexOf(" ");
    const docPath = text.slice(0, spaceIndex).trim();
    const issue = text.slice(spaceIndex + 1).trim();

    const normalizedPath = normalizePath(docPath);
    const { content, filePath, sha } = await fetchMarkdown(normalizedPath);

    const targetSection = findSectionHeading(issue);
    const { sectionMarkdown, sectionNodes } = await extractSection(content, targetSection);

    const updatedSection = await getOpenAISuggestion(targetSection, issue, sectionMarkdown);
    const newContent = replaceSection(content, sectionNodes, updatedSection);

    const prUrl = await createPR(filePath, newContent, username, sha);
    await postToSlack(response_url, `✅ PR created: ${prUrl}`);
  } catch (err) {
    console.error("❌", err.message);
    await postToSlack(response_url, `❌ Error: ${err.message}`);
  }
}

function normalizePath(p) {
  if (p.startsWith("http")) return new URL(p).pathname;
  if (!p.startsWith("/")) return "/" + p;
  return p;
}

function findSectionHeading(issue) {
  const match = issue.match(/`([^`]+)`/);
  if (!match) throw new Error("Include the section heading/code in backticks.");
  return match[1];
}

async function fetchMarkdown(docPath) {
  const base = `website/docs${docPath}`;
  const paths = [".md", ".mdx"].flatMap((ext) => [
    `${base}${ext}`,
    base.replace(/\/([^/]+)$/, (_, name) => `/${name.charAt(0).toUpperCase()}${name.slice(1)}`) + ext
  ]);

  for (const filePath of paths) {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json"
      }
    });

    if (res.ok) {
      const json = await res.json();
      const content = Buffer.from(json.content, "base64").toString("utf-8");
      return { content, filePath, sha: json.sha };
    }
  }

  throw new Error(`No .md or .mdx file found for ${docPath}`);
}

async function getOpenAISuggestion(sectionHeading, issue, content) {
  const prompt = `
You're a professional technical writer.

Only edit the section titled "${sectionHeading}" to address this issue:

${issue}

Don't change any other content. Keep structure, formatting, and tone consistent with official documentation.

--- SECTION START ---
${content}
--- SECTION END ---
`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3
    })
  });

  const json = await res.json();
  if (!json.choices?.length) throw new Error("OpenAI returned no suggestion");
  return json.choices[0].message.content.trim();
}

async function createPR(filePath, content, username, sha) {
  const [owner, repo] = GITHUB_REPO.split("/");
  const branch = `fixdoc-${Date.now()}`;

  const base = await octokit.git.getRef({ owner, repo, ref: "heads/main" });

  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    sha: base.data.object.sha
  });

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: filePath,
    message: `fix: ${filePath} updated by Slack bot`,
    content: Buffer.from(content).toString("base64"),
    sha,
    branch
  });

  const pr = await octokit.pulls.create({
    owner,
    repo,
    title: `Update ${filePath} via Slack`,
    head: branch,
    base: "main",
    body: `Reported by @${username} via Slack`
  });

  return pr.data.html_url;
}

async function postToSlack(url, text) {
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
}

app.listen(PORT, () => console.log(`🚀 Bot running at http://localhost:${PORT}`));
