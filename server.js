import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { Octokit } from "@octokit/rest";
import fs from "fs";

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
const PORT = process.env.PORT || 3000;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GITHUB_REPO = "appsmithorg/appsmith-docs";
const PROMPT_PATH = "./prompts/fixdoc_prompt.txt";

const octokit = new Octokit({ auth: GITHUB_TOKEN });

app.get("/", (_, res) => res.send("Slack bot is running ✅"));

app.post("/slack/fixdoc", async (req, res) => {
  const { text, user_name, response_url } = req.body;

  if (!text) return res.send("Please provide a path and issue description.");
  res.status(200).send(`Thanks <@${user_name}>! Working on: ${text}`);

  setTimeout(() => handleFixdocCommand(text, user_name, response_url), 0);
});

async function handleFixdocCommand(text, username, response_url) {
  try {
    const { inputPath, issue } = parseText(text);
    const normalizedPath = normalizePath(inputPath);
    const { content, filePath, sha } = await fetchMarkdown(normalizedPath);
    const updatedContent = await generateSuggestion(content, issue);
    const prUrl = await createPR(filePath, updatedContent, username, sha);

    await postToSlack(response_url, `✅ PR created: ${prUrl}`);
  } catch (err) {
    console.error("❌ Error:", err.message);
    await postToSlack(response_url, `❌ Error: ${err.message}`);
  }
}

function parseText(text) {
  const trimmed = text.trim().replace(/\s+/g, " ");
  const spaceIndex = trimmed.indexOf(" ");
  const inputPath = trimmed.slice(0, spaceIndex !== -1 ? spaceIndex : undefined).trim();
  const issue = spaceIndex !== -1 ? trimmed.slice(spaceIndex + 1).trim() : "";

  if (!inputPath) throw new Error("Please provide a valid path.");
  return { inputPath, issue };
}

function normalizePath(path) {
  try {
    if (path.startsWith("http")) {
      const url = new URL(path);
      path = url.pathname;
    }
    if (!path.startsWith("/")) path = "/" + path;
    return path;
  } catch {
    return path;
  }
}

async function fetchMarkdown(docPath) {
  const fileBase = `website/docs${docPath}`;
  const extensions = [".md", ".mdx"];
  const candidates = [];

  for (const ext of extensions) {
    candidates.push(`${fileBase}${ext}`);
    const capitalized = fileBase.replace(/\/([^/]+)$/, (_, name) => `/${name.charAt(0).toUpperCase()}${name.slice(1)}`);
    candidates.push(`${capitalized}${ext}`);
  }

  for (const filePath of candidates) {
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

  throw new Error(`❌ Could not find a .md or .mdx file for: ${docPath}`);
}

async function generateSuggestion(content, issue) {
  const promptTemplate = fs.readFileSync(PROMPT_PATH, "utf-8");

  const finalPrompt = `${promptTemplate}

---

## 🧾 Original Markdown Content

${content}

---

## 🐞 User Reported Issue

${issue}

---

## ✅ Instructions

Update the markdown content accordingly. Do not reformat unrelated sections or remove valid content. Only modify parts needed to address the issue. Return the full updated markdown content.
`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4",
      messages: [{ role: "user", content: finalPrompt }],
      temperature: 0.3
    })
  });

  const json = await res.json();
  if (!json.choices || !json.choices.length) throw new Error("OpenAI did not return any suggestion.");
  return json.choices[0].message.content;
}

async function createPR(filePath, content, username, sha) {
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
    content: Buffer.from(content).toString("base64"),
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
