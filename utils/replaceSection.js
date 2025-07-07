import { unified } from "unified";
import parse from "remark-parse";
import stringify from "remark-stringify";

export function replaceSection(originalMarkdown, oldNodes, newMarkdown) {
  const tree = unified().use(parse).parse(originalMarkdown);
  const newTree = unified().use(parse).parse(newMarkdown);

  const startIdx = tree.children.findIndex((n) => n === oldNodes[0]);
  if (startIdx === -1) throw new Error("Section not found in original AST.");

  tree.children.splice(startIdx, oldNodes.length, ...newTree.children);

  return unified().use(stringify).stringify(tree);
}
