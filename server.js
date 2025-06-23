import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.send("Slack bot is running ✅");
});

app.post("/slack/fixdoc", (req, res) => {
  const { text, user_name } = req.body || {};
  console.log(`[Slack] ${user_name} submitted: ${text}`);

  res.status(200).send(`✅ Thanks <@${user_name}>! We'll fix: *${text}*`);
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
