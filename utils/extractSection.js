import { unified } from "unified";
import parse from "remark-parse";
import stringify from "remark-stringify";

export async function extractSection(markdown, headingText) {
  const tree = unified().use(parse).parse(markdown);

  const sectionNodes = [];
  let capture = false;

  for (const node of tree.children) {
    if (node.type === "heading" && node.depth === 3) {
      const title = node.children.map((c) => c.value).join("");
      if (title.includes(headingText)) {
        capture = true;
      } else if (capture) {
        break;
      }
    }
    if (capture) sectionNodes.push(node);
  }

  if (!sectionNodes.length) throw new Error(`Section "${headingText}" not found.`);

  const sectionTree = { type: "root", children: sectionNodes };
  const sectionMarkdown = unified().use(stringify).stringify(sectionTree);

  return { sectionMarkdown, sectionNodes };
}
