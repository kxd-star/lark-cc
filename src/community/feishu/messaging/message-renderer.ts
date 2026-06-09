import fs from "node:fs";
import nodePath from "node:path";

import {
  config,
  type AssistantMessage,
  type BashToolUseMessageContent,
  type EditToolUseMessageContent,
  type GlobToolUseMessageContent,
  type GrepToolUseMessageContent,
  type ReadToolUseMessageContent,
  type SkillToolUseMessageContent,
  type ToolUseMessageContent,
  type WebFetchToolUseMessageContent,
  type WebSearchToolUseMessageContent,
  type WriteToolUseMessageContent,
} from "@/shared";

import type { Card } from "./types";

const MAX_FEISHU_CARD_ELEMENTS = 200;
// eslint-disable-next-line no-unused-vars
type UploadImageFn = (path: string) => Promise<string>;

/** Tool name → emoji + Chinese label */
const TOOL_LABEL: Record<string, string> = {
  Agent:      "🤖 子任务",
  Task:       "🤖 子任务",
  Bash:       "⚡ 执行命令",
  Edit:       "✏️ 修改文件",
  Write:      "✏️ 写入文件",
  Read:       "📄 读取文件",
  Glob:       "🔍 搜索文件",
  Grep:       "📖 搜索内容",
  WebSearch:  "🔍 搜索网络",
  WebFetch:   "🌐 抓取网页",
  Skill:      "🧩 加载技能",
  ToolSearch: "🔎 搜索工具",
};

function toolSummary(content: ToolUseMessageContent): string {
  switch (content.name) {
    case "Bash": {
      const bash = content as BashToolUseMessageContent;
      return bash.input.description ?? bash.input.command?.substring(0, 60) ?? "";
    }
    case "Edit": return (content as EditToolUseMessageContent).input.file_path;
    case "Write": return (content as WriteToolUseMessageContent).input.file_path;
    case "Read": return (content as ReadToolUseMessageContent).input.file_path;
    case "Glob": return (content as GlobToolUseMessageContent).input.pattern;
    case "Grep": return (content as GrepToolUseMessageContent).input.pattern;
    case "WebSearch": return (content as WebSearchToolUseMessageContent).input.query;
    case "WebFetch": return (content as WebFetchToolUseMessageContent).input.url;
    case "Skill": return (content as SkillToolUseMessageContent).input.skill;
    default: return content.name;
  }
}

/** Streaming status text. */
function statusText(streaming: boolean, content: AssistantMessage["content"]): string {
  if (!streaming) return "";
  const last = content[content.length - 1];
  if (!last) return "🤔 思考中…";
  if (last.type === "tool_use") return `🧰 ${TOOL_LABEL[last.name] ?? last.name}`;
  if (last.type === "text") return "✍️ 正在输出…";
  return "🧠 正在思考…";
}

/**
 * Render assistant message content as a Feishu interactive card.
 * Uses a single collapsible panel with step-by-step div elements,
 * enhanced with emoji labels and Chinese status text.
 */
export async function renderMessageCard(
  messageContent: AssistantMessage["content"],
  {
    streaming,
    uploadImage,
  }: {
    streaming: boolean;
    sessionId?: string;
    uploadImage: UploadImageFn;
  },
): Promise<Card> {
  const bodyElements: Card["body"]["elements"] = [];

  // Initial/empty state
  if (streaming && messageContent.length === 0) {
    bodyElements.push({
      tag: "div",
      icon: { tag: "standard_icon", token: "more_outlined", color: "grey" },
      text: { tag: "plain_text", content: "🤔 思考中…", text_color: "grey", text_size: "notation" },
    });
  }

  // Thinking blocks → collapsible panel
  const thinkingTexts: string[] = [];
  const toolSteps: Array<{ name: string; summary: string }> = [];

  for (const c of messageContent) {
    if (c.type === "thinking") {
      const t = c.thinking.trim();
      if (t) thinkingTexts.push(t);
    } else if (c.type === "tool_use") {
      toolSteps.push({ name: c.name, summary: toolSummary(c) });
    } else if (c.type === "text" && c.text.trim() && !streaming) {
      // Only show final text when streaming is done
    }
  }

  // Thinking panel (merge all thinking into one)
  if (thinkingTexts.length > 0) {
    const merged = thinkingTexts.join("\n\n");
    const truncated = merged.length > 1500 ? merged.slice(0, 1500) + "…" : merged;
    bodyElements.push({
      tag: "collapsible_panel",
      expanded: false,
      border: { color: "grey-300", corner_radius: "6px" },
      vertical_spacing: "2px",
      header: {
        title: { tag: "plain_text", content: "🧠 思考", text_color: "grey", text_size: "notation" },
        icon: { tag: "standard_icon", token: "right_outlined", color: "grey" },
        icon_position: "right",
        icon_expanded_angle: 90,
      },
      elements: [{ tag: "markdown", content: truncated, text_size: "notation" }],
    });
  }

  // Tool steps — merge consecutive same-type into collapsible
  let i = 0;
  while (i < toolSteps.length) {
    const { name: curName, summary: curSummary } = toolSteps[i]!;

    // Count consecutive same-type steps
    let j = i + 1;
    while (j < toolSteps.length && toolSteps[j]!.name === curName) j++;
    const count = j - i;

    const label = TOOL_LABEL[curName] ?? `🛠️ ${curName}`;

    if (count === 1) {
      // Single step → simple div
      const text = curSummary ? `${label} — ${curSummary}` : label;
      bodyElements.push({
        tag: "div",
        icon: { tag: "standard_icon", token: "right_outlined", color: "grey" },
        text: { tag: "plain_text", content: text, text_color: "grey", text_size: "notation" },
      });
    } else {
      // Multiple consecutive same-type steps → collapsible panel
      const summaries = toolSteps.slice(i, j).map((s) => s.summary).filter(Boolean);
      const headerText = count > 1 ? `${label}（${count}次）` : label;
      const details = summaries.map((s, idx) => `${idx + 1}. ${s}`).join("\n");
      bodyElements.push({
        tag: "collapsible_panel",
        expanded: false,
        border: { color: "grey-300", corner_radius: "6px" },
        vertical_spacing: "2px",
        header: {
          title: { tag: "plain_text", content: headerText, text_color: "grey", text_size: "notation" },
          icon: { tag: "standard_icon", token: "right_outlined", color: "grey" },
          icon_position: "right",
          icon_expanded_angle: 90,
        },
        elements: [{ tag: "markdown", content: details, text_size: "notation" }],
      });
    }

    i = j;
  }

  // Streaming status
  const status = statusText(streaming, messageContent);
  if (status) {
    bodyElements.push({
      tag: "div",
      icon: { tag: "standard_icon", token: "more_outlined", color: "grey" },
      text: { tag: "plain_text", content: status, text_color: "grey", text_size: "notation" },
    });
  }

  // Final answer text
  if (!streaming) {
    const lastText = messageContent.findLast((c) => c.type === "text");
    if (lastText) {
      const md = await _uploadMessageResource(lastText.text, { uploadImage });
      bodyElements.push({ tag: "markdown", content: md });
    }
  }

  // Empty-body fallback
  if (bodyElements.length === 0) {
    bodyElements.push({ tag: "div", text: { tag: "plain_text", content: "" } });
  }

  // Summary
  const summary = (() => {
    if (!streaming) {
      const t = messageContent.findLast((c) => c.type === "text");
      if (t?.type === "text") {
        const clean = t.text.replace(/!\[.*?\]\(.*?\)/g, "").trim();
        if (clean) return clean.length > 50 ? clean.slice(0, 50) + "…" : clean;
      }
      return "已完成";
    }
    return statusText(true, messageContent);
  })();

  const card: Card = {
    schema: "2.0",
    config: {
      streaming_mode: true,
      enable_forward: true,
      enable_forward_interaction: true,
      update_multi: true,
      width_mode: "fill",
      summary: typeof summary === "object" ? { content: "" } : { content: summary },
    },
    body: { elements: bodyElements },
  };

  _trimCardElements(card);
  return card;
}

function _trimCardElements(card: Card) {
  let count = _countElements(card);
  if (card.body.elements.length === 0 || count <= MAX_FEISHU_CARD_ELEMENTS) return;
  while (card.body.elements.length > 0 && count > MAX_FEISHU_CARD_ELEMENTS) {
    const removed = card.body.elements.shift()!;
    count -= _countElements(removed);
  }
}

function _countElements(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const item = value as Record<string, unknown>;
  const self = typeof item.tag === "string" ? 1 : 0;
  return Object.values(item).reduce<number>(
    (acc, child) =>
      acc + (Array.isArray(child) ? child.reduce((s, e) => s + _countElements(e), 0) : _countElements(child)),
    self,
  );
}

async function _uploadMessageResource(
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
