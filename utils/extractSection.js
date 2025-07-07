import { unified } from "unified";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";

export function extractSection(content, issue) {
  const lines = content.split("\n");
  const lowerIssue = issue.toLowerCase();

  let sectionStart = -1;
  let sectionEnd = lines.length;
  let sectionHeading = "";

  for (let i = 0; i < lines.length; i++) {
    if (/^##+\s/.test(lines[i])) {
      if (sectionStart === -1 && lowerIssue.includes(lines[i].toLowerCase())) {
        sectionStart = i;
        sectionHeading = lines[i];
      } else if (sectionStart !== -1) {
        sectionEnd = i;
        break;
      }
    }
  }

  if (sectionStart === -1) return { section: null };
  const section = lines.slice(sectionStart, sectionEnd).join("\n");
  return { section, sectionHeading };
}
