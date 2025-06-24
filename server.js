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
    const fullPath = `docs${path}.mdx`;

    const content = await fetchMarkdown(fullPath);
    const suggestion = await getOpenAISuggestion(issue, content);
    const prUrl = await createPR(fullPath, suggestion, username);

    await postToSlack(response_url, `✅ PR created: ${prUrl}`);
  } catch (err) {
    console.error(err);
    await postToSlack(response_url, `❌ Error: ${err.message}`);
  }
}

async function fetchMarkdown(filePath) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3.raw",
    }
  });

  if (!res.ok) throw new Error("Unable to fetch file from GitHub");
  return await res.text();
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
  return json.choices[0].message.content;
}

async function createPR(filePath, updatedContent, username) {
  const [owner, repo] = GITHUB_REPO.split("/");
  const branch = `fixdoc-${Date.now()}`;

  const baseRef = await octokit.git.getRef({ owner, repo, ref: "heads/main" });
  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    sha: baseRef.data.object.sha
  });

  const { data: file } = await octokit.repos.getContent({ owner, repo, path: filePath, ref: "main" });
  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: filePath,
    message: `fix: ${filePath} via Slack`,
    content: Buffer.from(updatedContent).toString("base64"),
    sha: file.sha,
    branch
  });

  const { data: pr } = await octokit.pulls.create({
    owner,
    repo,
    title: `Fix ${filePath} via Slack`,
    head: branch,
    base: "main",
    body: `Reported by ${username} via Slack bot`
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
