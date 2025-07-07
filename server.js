import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { Octokit } from "@octokit/rest";
import similarity from "string-similarity";

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
const PORT = process.env.PORT || 3000;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GITHUB_REPO = "appsmithorg/appsmith-docs";
const REPO_PATH = "website/docs";
const octokit = new Octokit({ auth: GITHUB_TOKEN });

let knownDocs = [];

app.get("/", (_, res) => res.send("Slack bot is running ✅"));

app.post("/slack/fixdoc", async (req, res) => {
  const { text, user_name, response_url } = req.body;

  if (!text) return res.send("Please provide a file path and issue description.");
  res.status(200).send(`Thanks <@${user_name}>! Working on: ${text}`);

  setTimeout(() => processFixdocCommand(text, user_name, response_url), 0);
});

async function processFixdocCommand(text, username, response_url) {
  try {
    const { inputPath, issue } = parseFixdocText(text);
    const normalizedPath = normalizeDocPath(inputPath);
    const { content, filePath, sha } = await fetchBestMatchFile(normalizedPath);
    const suggestion = await getOpenAISuggestion(issue, content, filePath);
    const prUrl = await createPR(filePath, suggestion, username, sha);
    await postToSlack(response_url, `✅ PR created: ${prUrl}`);
  } catch (err) {
    console.error("❌ Bot Error:", err.message);
    await postToSlack(response_url, `❌ Error: ${err.message}`);
  }
}

function parseFixdocText(text) {
  const normalized = text.trim().replace(/\r?\n/g, " ").replace(/\s+/g, " ");
  const spaceIndex = normalized.indexOf(" ");
  const inputPath = normalized.slice(0, spaceIndex !== -1 ? spaceIndex : undefined).trim();
  const issue = spaceIndex !== -1 ? normalized.slice(spaceIndex + 1).trim() : "";
  if (!inputPath) throw new Error("Please provide a valid path.");
  return { inputPath, issue };
}

function normalizeDocPath(path) {
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

async function fetchBestMatchFile(userPath) {
  if (!knownDocs.length) await preloadKnownFiles();

  const scores = knownDocs.map(file => ({
    file,
    score: similarity.compareTwoStrings(file.docPath, userPath)
  }));

  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  if (best.score < 0.5) throw new Error(`❌ No close match found for: ${userPath}`);

  const { filePath } = best.file;
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json"
    }
  });

  if (!res.ok) throw new Error(`❌ GitHub fetch failed for: ${filePath}`);
  const json = await res.json();
  const content = Buffer.from(json.content, "base64").toString("utf-8");

  return { content, filePath, sha: json.sha };
}

async function preloadKnownFiles() {
  const files = await fetchDocsFromRepo(REPO_PATH);
  knownDocs = files.filter(f => f.name.endsWith(".md") || f.name.endsWith(".mdx")).map(f => ({
    docPath: "/" + f.path.replace("website/docs", "").replace(/\.(md|mdx)$/, ""),
    filePath: f.path
  }));
}

async function fetchDocsFromRepo(path, acc = []) {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}` }
  });

  if (!res.ok) return acc;

  const items = await res.json();
  for (const item of items) {
    if (item.type === "file") {
      acc.push({ path: item.path, name: item.name });
    } else if (item.type === "dir") {
      await fetchDocsFromRepo(item.path, acc);
    }
  }
  return acc;
}

async function getOpenAISuggestion(issue, content, filePath) {
  const fileName = filePath.split("/").pop();
  const prompt = `
You are a senior technical writer. You are contributing to Appsmith's open-source documentation at \`${filePath}\`.

Please follow these rules:

---

## ✍️ Editorial Guidelines

- Structure content using [Diátaxis](https://diataxis.fr/).
- Follow [Google Developer Style Guide](https://developers.google.com/style) for clarity and tone.
- Be direct, instructional, and precise.
- Headings must use sentence case.
- Avoid "we", "our", "you should", or first-person plural.
- Use backticks for inline code or UI labels.
- New sections should follow existing markdown formatting.
- Use examples or lists if needed to explain concepts.

---

## 🐞 Reported Issue

${issue}

---

## 📄 Original Markdown

${content}

---

## ✅ Response Instructions

Revise the **entire markdown** file to address the issue. Return updated markdown only — no comments, no explanation.
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
  if (!json.choices || !json.choices.length) {
    console.error("OpenAI Error:", json);
    throw new Error("❌ OpenAI did not return suggestions.");
  }

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

app.listen(PORT, async () => {
  console.log(`🚀 Slack bot running on port ${PORT}`);
  await preloadKnownFiles();
  console.log(`📂 Indexed ${knownDocs.length} docs for fuzzy matching`);
});
