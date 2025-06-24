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
    const { inputPath, issue } = parseFixdocText(text);
    const normalizedPath = normalizeDocPath(inputPath);

    const { content, filePath, sha } = await fetchMarkdown(normalizedPath);
    const suggestion = await getOpenAISuggestion(issue, content);
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

async function fetchMarkdown(docPath) {
  const fileBase = `website/docs${docPath}`;
  const exts = [".md", ".mdx"];
  const candidates = [];

  for (const ext of exts) {
    candidates.push(`${fileBase}${ext}`);

    // Try capitalized last segment too
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
      if (!json.content || !json.sha) throw new Error(`GitHub response missing content/sha`);
      const content = Buffer.from(json.content, "base64").toString("utf-8");
      return { content, filePath, sha: json.sha };
    }
  }

  throw new Error(`❌ Could not find a .md or .mdx file for: ${docPath}`);
}

async function getOpenAISuggestion(issue, content) {
  const prompt = `
You are a senior technical writer contributing to official product documentation.

Follow these strict rules while editing the markdown content:

## ✍️ Style and Structure Guidelines

- Use the [Diátaxis documentation framework](https://diataxis.fr/) — keep content instructional, with clear purpose (tutorial, reference, guide, or explanation).
- Follow the [Google Developer Documentation Style Guide](https://developers.google.com/style) for tone, clarity, terminology, punctuation, and formatting.
- Be clear, concise, and consistent.
- Use present tense and active voice.
- Headings must be in sentence case, not title case.
- Never use "we", "our", or "you should".
- Use second person ("you") sparingly and only when instructional.
- Format all inline code, URLs, filenames, or settings using backticks.
- If adding new sections, ensure they match existing formatting (e.g. \`## Automated execution\`, or similar).
- Maintain Appsmith’s documentation tone and language.

---

## 🧾 Original Markdown Content

${content}

---

## 🐞 User Reported Issue

${issue}

---

## ✅ Instructions

Update the markdown content accordingly. Do not reply with comments or analysis — only return the **entire modified markdown content** (even if only one line changed). Keep unchanged content intact.

If you're adding a new section, place it where it best fits the page’s flow.

Be professional, structured, and editorially consistent.
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
    console.error("❌ OpenAI Error:", JSON.stringify(json, null, 2));
    throw new Error("❌ OpenAI did not return any suggestions.");
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

app.listen(PORT, () => console.log(`🚀 Slack bot running on port ${PORT}`));
