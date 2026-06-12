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

import type { Card, CollapsiblePanel, DivElement } from "./types/interactive";

const MAX_FEISHU_CARD_ELEMENTS = 200;
// eslint-disable-next-line no-unused-vars
type UploadImageFn = (path: string) => Promise<string>;

// ── Phase definitions ─────────────────────────────────────────────────────

interface PhaseDef {
  key: string;
  label: string;         // Completed label (e.g. "查找完毕")
  activeLabel: string;   // In-progress label (e.g. "查找中")
  iconToken: string;     // Feishu standard icon token
  // eslint-disable-next-line no-unused-vars
  match: (name: string) => boolean;
}

const PHASES: PhaseDef[] = [
  {
    key: "search",
    label: "查找完毕",
    activeLabel: "查找中",
    iconToken: "search_outlined",
    match: (n) => ["WebSearch", "WebFetch", "Glob", "Grep", "Read"].includes(n),
  },
  {
    key: "analyze",
    label: "分析完成",
    activeLabel: "分析中",
    iconToken: "file-link-mindnote_outlined",
    match: (n) => ["Agent", "Task"].includes(n),
  },
  {
    key: "plan",
    label: "规划完成",
    activeLabel: "规划中",
    iconToken: "file-link-bitable_outlined",
    match: (n) => ["Skill", "ToolSearch"].includes(n),
  },
  {
    key: "code",
    label: "编码完成",
    activeLabel: "编码中",
    iconToken: "edit_outlined",
    match: (n) => ["Edit", "Write"].includes(n),
  },
  {
    key: "execute",
    label: "执行完成",
    activeLabel: "执行中",
    iconToken: "computer_outlined",
    match: (n) => ["Bash"].includes(n),
  },
];

function _classifyToolName(toolName: string): string {
  return PHASES.find((p) => p.match(toolName))?.key ?? "execute";
}

/** Create a step div element from a tool use content. */
function _createStepFromTool(content: ToolUseMessageContent): DivElement {
  switch (content.name) {
    case "Agent":
    case "Task":
      return _renderStep("运行子智能体", "robot_outlined");
    case "Bash": {
      const bash = content as BashToolUseMessageContent;
      return _renderStep(
        bash.input.description ?? bash.input.command?.substring(0, 60) ?? "",
        "computer_outlined",
      );
    }
    case "Edit": {
      const edit = content as EditToolUseMessageContent;
      return _renderStep(`编辑 "${edit.input.file_path}"`, "edit_outlined");
    }
    case "Write": {
      const write = content as WriteToolUseMessageContent;
      return _renderStep(`写入 "${write.input.file_path}"`, "edit_outlined");
    }
    case "Read": {
      const read = content as ReadToolUseMessageContent;
      return _renderStep(`读取 "${read.input.file_path}"`, "file-link-bitable_outlined");
    }
    case "Glob": {
      const glob = content as GlobToolUseMessageContent;
      return _renderStep(`搜索文件 "${glob.input.pattern}"`, "card-search_outlined");
    }
    case "Grep": {
      const grep = content as GrepToolUseMessageContent;
      return _renderStep(`搜索内容 "${grep.input.pattern}"`, "doc-search_outlined");
    }
    case "WebSearch": {
      const ws = content as WebSearchToolUseMessageContent;
      return _renderStep(`搜索 "${ws.input.query}"`, "search_outlined");
    }
    case "WebFetch": {
      const wf = content as WebFetchToolUseMessageContent;
      return _renderStep(`读取网页 "${wf.input.url}"`, "language_outlined");
    }
    case "Skill": {
      const skill = content as SkillToolUseMessageContent;
      return _renderStep(`加载技能 "${skill.input.skill}"`, "file-link-mindnote_outlined");
    }
    case "ToolSearch":
      return _renderStep("搜索工具", "search_outlined");
    default:
      return _renderStep(content.name, "setting-inter_outlined");
  }
}

/** Create a simple step div. */
function _renderStep(text: string, iconToken: string): DivElement {
  return {
    tag: "div",
    icon: { tag: "standard_icon", token: iconToken, color: "grey" },
    text: { tag: "plain_text", text_color: "grey", text_size: "notation", content: text },
  };
}

/** Build a collapsible panel for a phase group. */
function _createPhasePanel(
  phase: PhaseDef,
  isActive: boolean,
  streaming: boolean,
  stepElements: DivElement[],
): CollapsiblePanel {
  const stepCount = stepElements.length;
  const isLive = streaming && isActive;

  return {
    tag: "collapsible_panel",
    expanded: isLive, // Only expand the active phase while streaming
    border: {
      color: isLive ? "blue-300" : "grey-300",
      corner_radius: "6px",
    },
    vertical_spacing: "2px",
    header: {
      title: {
        tag: "plain_text",
        text_color: isLive ? "blue" : "grey",
        text_size: "notation",
        content: isLive
          ? `▶ ${phase.activeLabel} ${stepCount}步`
          : `${phase.label} ${stepCount}步`,
      },
      icon: {
        tag: "standard_icon",
        token: phase.iconToken,
        color: isLive ? "blue" : "grey",
      },
      icon_position: "right",
      icon_expanded_angle: 90,
    },
    elements: stepElements,
  };
}

// ── Status text ───────────────────────────────────────────────────────────

function _statusText(streaming: boolean, content: AssistantMessage["content"]): string {
  if (!streaming) return "";
  const last = content[content.length - 1];
  if (!last) return "🤔 思考中…";
  if (last.type === "thinking") return "🧠 思考中…";
  if (last.type === "tool_use") {
    const phaseKey = _classifyToolName(last.name);
    const phase = PHASES.find((p) => p.key === phaseKey);
    return `🧰 ${phase?.activeLabel ?? "处理中"}…`;
  }
  if (last.type === "text") return "✍️ 正在输出…";
  return "🤔 思考中…";
}

// ── Main renderer ─────────────────────────────────────────────────────────

/**
 * Render assistant message content as a Feishu interactive card.
 *
 * Groups tool calls into phase panels (查找/分析/规划/编码/执行) for
 * a high-level progress overview. The active phase is highlighted in blue
 * and expanded; completed phases are collapsed.
 *
 * Signature is identical to the emoji-step version — only the card layout
 * changes, no impact on message-channel.ts or other callers.
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

  // ── Initial/empty state ──────────────────────────────────────────────
  if (streaming && messageContent.length === 0) {
    bodyElements.push({
      tag: "div",
      icon: { tag: "standard_icon", token: "more_outlined", color: "grey" },
      text: { tag: "plain_text", content: "🤔 思考中…", text_color: "grey", text_size: "notation" },
    });
  }

  // ── Collect thinking blocks and tool calls ────────────────────────────
  const thinkingTexts: string[] = [];
  const toolCalls: ToolUseMessageContent[] = [];

  for (const c of messageContent) {
    if (c.type === "thinking") {
      const t = c.thinking.trim();
      if (t) thinkingTexts.push(t);
    } else if (c.type === "tool_use") {
      toolCalls.push(c);
    }
  }

  // ── Thinking panel ───────────────────────────────────────────────────
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

  // ── Group tool calls by phase ────────────────────────────────────────
  if (toolCalls.length > 0) {
    const phaseSteps = new Map<string, DivElement[]>();
    const phaseOrder: string[] = [];

    for (const tc of toolCalls) {
      const step = _createStepFromTool(tc);
      const phaseKey = _classifyToolName(tc.name);

      if (!phaseSteps.has(phaseKey)) {
        phaseSteps.set(phaseKey, []);
        phaseOrder.push(phaseKey);
      }
      phaseSteps.get(phaseKey)!.push(step);
    }

    // Determine active phase (last tool call in streaming mode)
    const activePhaseKey = streaming
      ? _classifyToolName(toolCalls[toolCalls.length - 1]!.name)
      : null;

    // Render phase panels in order of first appearance
    for (const phaseKey of phaseOrder) {
      const phase = PHASES.find((p) => p.key === phaseKey);
      if (!phase) continue;
      const steps = phaseSteps.get(phaseKey)!;
      bodyElements.push(
        _createPhasePanel(phase, phaseKey === activePhaseKey, streaming, steps),
      );
    }
  }

  // ── Streaming status ─────────────────────────────────────────────────
  const status = _statusText(streaming, messageContent);
  if (status) {
    bodyElements.push({
      tag: "div",
      icon: { tag: "standard_icon", token: "more_outlined", color: "grey" },
      text: { tag: "plain_text", content: status, text_color: "grey", text_size: "notation" },
    });
  }

  // ── Final answer text ────────────────────────────────────────────────
  if (!streaming) {
    const lastText = messageContent.findLast((c) => c.type === "text");
    if (lastText) {
      const md = await _uploadMessageResource(lastText.text, { uploadImage });
      bodyElements.push({ tag: "markdown", content: md });
    }
  }

  // ── Empty-body fallback ──────────────────────────────────────────────
  if (bodyElements.length === 0) {
    bodyElements.push({ tag: "div", text: { tag: "plain_text", content: "" } });
  }

  // ── Card summary ─────────────────────────────────────────────────────
  const summary = (() => {
    if (!streaming) {
      const t = messageContent.findLast((c) => c.type === "text");
      if (t?.type === "text") {
        const clean = t.text.replace(/!\[.*?\]\(.*?\)/g, "").trim();
        if (clean) return clean.length > 50 ? clean.slice(0, 50) + "…" : clean;
      }
      return "已完成";
    }
    return _statusText(true, messageContent);
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

// ── Helpers (unchanged) ────────────────────────────────────────────────────

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
