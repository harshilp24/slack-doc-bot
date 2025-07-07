export function replaceSection(content, heading, newSection) {
  const lines = content.split("\n");
  const startIndex = lines.findIndex(line => line.trim() === heading.trim());
  if (startIndex === -1) throw new Error("Failed to locate section to replace.");

  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (/^##+\s/.test(lines[i])) {
      endIndex = i;
      break;
    }
  }

  const updatedLines = [
    ...lines.slice(0, startIndex),
    ...newSection.split("\n"),
    ...lines.slice(endIndex)
  ];

  return updatedLines.join("\n");
}
