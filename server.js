import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { Octokit } from "@octokit/rest";

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
const PORT = process.env.PORT || 3000;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GITHUB_REPO = "appsmithorg/appsmith-docs";
const octokit = new Octokit({ auth: GITHUB_TOKEN });

app.get("/", (_, res) => res.send("Slack bot is running ✅"));

app.post("/slack/fixdoc", async (req, res) => {
  const { text, user_name, response_url } = req.body;

  if (!text) return res.send("Please provide a file path and issue description.");
  res.status(200).send(`Thanks <@${user_name}>! Working on: ${text}`);

  setTimeout(() => processFixdocCommand(text, user_name, response_url), 0);
});

async function processFixdocCommand(text, username, response_url) {
  try {
    const [path, ...issueParts] = text.trim().split(" ");
    const issue = issueParts.join(" ").trim();

    const { content, filePath, sha } = await fetchMarkdown(path);
    const suggestion = await getOpenAISuggestion(issue, content);
    const prUrl = await createPR(filePath, suggestion, username, sha);

    await postToSlack(response_url, `✅ PR created: ${prUrl}`);
  } catch (err) {
    console.error(err);
    await postToSlack(response_url, `❌ Error: ${err.message}`);
  }
}

async function fetchMarkdown(path) {
  const exts = [".md", ".mdx"];
  const base = `website/docs${path}`;
  const pathVariants = [];

  for (const ext of exts) {
    // 1. Exact case
    pathVariants.push(`${base}${ext}`);

    // 2. Capitalized filename
    const capitalized = base.replace(/\/([^/]+)$/, (_, name) =>
      `/${name.charAt(0).toUpperCase()}${name.slice(1)}`
    );
    pathVariants.push(`${capitalized}${ext}`);
  }

  for (const filePath of pathVariants) {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json"
      }
    });

    if (res.ok) {
      const json = await res.json();
      const content = Buffer.from(json.content, "base64").toString("utf-8");
      return { content, filePath, sha: json.sha };
    }
  }

  throw new Error(`❌ Could not find a .md or .mdx file for: ${base}`);
}

async function getOpenAISuggestion(issue, content) {
  const prompt = `
A user found an issue in the following markdown content.

--- Markdown Content ---
${content}

--- Issue Description ---
${issue}

--- Fix the content below ---
`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3
    })
  });

  const json = await res.json();
  if (!json.choices) throw new Error("❌ OpenAI did not return any suggestions.");
  return json.choices[0].message.content;
}

async function createPR(filePath, updatedContent, username, sha) {
  const [owner, repo] = GITHUB_REPO.split("/");
  const branch = `fixdoc-${Date.now()}`;

  const baseRef = await octokit.git.getRef({ owner, repo, ref: "heads/main" });
  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    sha: baseRef.data.object.sha
  });

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: filePath,
    message: `fix: ${filePath} via Slack bot`,
    content: Buffer.from(updatedContent).toString("base64"),
    sha,
    branch
  });

  const { data: pr } = await octokit.pulls.create({
    owner,
    repo,
    title: `Fix ${filePath} via Slack`,
    head: branch,
    base: "main",
    body: `Reported by @${username} via Slack bot`
  });

  return pr.html_url;
}

async function postToSlack(url, text) {
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
}

app.listen(PORT, () => console.log(`🚀 Slack bot running on port ${PORT}`));
