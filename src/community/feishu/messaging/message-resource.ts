import fs from "node:fs";
import nodePath from "node:path";

import { config } from "@/shared";

// eslint-disable-next-line no-unused-vars
type UploadImageFn = (path: string) => Promise<string>;

export async function uploadMessageResource(
  text: string,
  { uploadImage }: { uploadImage: UploadImageFn },
): Promise<string> {
  const images = text.match(/!\[.*?\]\((.*?)\)/g);
  if (!images) return text;
  for (const img of images) {
    let src = img.match(/!\[.*?\]\((.*?)\)/)?.[1];
    if (!src) continue;
    if (src.startsWith("http:") || src.startsWith("https:")) {
      try {
        const res = await fetch(src);
        const buf = await res.arrayBuffer();
        const name = src.split("/").pop();
        const dir = nodePath.join(config.paths.workspace, "downloads");
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (name) {
          fs.writeFileSync(nodePath.join(dir, name), Buffer.from(buf));
          src = nodePath.join("workspace", "downloads", name);
        }
      } catch {
        text = text.replaceAll(img, `[${src}](${src})`);
        continue;
      }
    }
    if (fs.existsSync(nodePath.join(config.paths.home, src))) {
      const key = await uploadImage(src);
      text = text.replaceAll(img, `![image](${key})`);
    } else {
      text = text.replaceAll(img, "");
    }
  }
  return text;
}

const MARKDOWN_TABLE_REGEX = /^\|.+\|[ \t]*\n\|[\s:|-]+\|[ \t]*\n(?:\|.+\|[ \t]*\n?)+/gm;

export function splitMarkdownByTables(
  markdown: string,
  maxTables: number = 5,
): string[] {
  const tables = markdown.match(MARKDOWN_TABLE_REGEX);
  if (!tables || tables.length <= maxTables) return [markdown];
  const tablePositions: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  const regex = new RegExp(MARKDOWN_TABLE_REGEX.source, "gm");
  while ((match = regex.exec(markdown)) !== null) {
    tablePositions.push({ start: match.index, end: match.index + match[0].length });
  }
  const chunks: string[] = [];
  let pos = 0;
  let tablesInChunk = 0;
  for (let i = 0; i < tablePositions.length; i++) {
    tablesInChunk++;
    if (tablesInChunk >= maxTables && i < tablePositions.length - 1) {
      chunks.push(markdown.slice(pos, tablePositions[i]!.end).trim());
      pos = tablePositions[i]!.end;
      tablesInChunk = 0;
    }
  }
  const remaining = markdown.slice(pos).trim();
  if (remaining) chunks.push(remaining);
  return chunks;
}
