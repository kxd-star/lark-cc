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

import type {
  ActionElement,
  Card,
  CollapsiblePanel,
  DivElement,
} from "./types";

/** Maximum elements or components in one Feishu card. */
const MAX_FEISHU_CARD_ELEMENTS = 200;

// eslint-disable-next-line no-unused-vars
type UploadImageFn = (path: string) => Promise<string>;

interface PhaseDef {
  key: string;
  label: string;
  activeLabel: string;
  iconToken: string;
  // eslint-disable-next-line no-unused-vars
  match: (name: string) => boolean;
}

const PHASES: PhaseDef[] = [
  {
    key: "search",
    label: "查找",
    activeLabel: "查找中",
    iconToken: "search_outlined",
    match: (n) =>
      ["WebSearch", "WebFetch", "Glob", "Grep", "Read"].includes(n),
  },
  {
    key: "analyze",
    label: "分析",
    activeLabel: "分析中",
    iconToken: "file-link-mindnote_outlined",
    match: (n) => ["Agent", "Task"].includes(n),
  },
  {
    key: "plan",
    label: "规划",
    activeLabel: "规划中",
    iconToken: "file-link-bitable_outlined",
    match: (n) => ["Skill", "ToolSearch"].includes(n),
  },
  {
    key: "code",
    label: "编码",
    activeLabel: "编码中",
    iconToken: "edit_outlined",
    match: (n) => ["Edit", "Write"].includes(n),
  },
  {
    key: "execute",
    label: "执行",
    activeLabel: "执行中",
    iconToken: "computer_outlined",
    match: (n) => ["Bash"].includes(n),
  },
];

/** Find which phase key a tool name belongs to. */
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
        bash.input.description ?? bash.input.command.substring(0, 60),
        "computer_outlined",
      );
    }
    case "Edit": {
      const edit = content as EditToolUseMessageContent;
      return _renderStep(`编辑 "${edit.input.file_path}"`, "edit_outlined");
    }
    case "Glob": {
      const glob = content as GlobToolUseMessageContent;
      return _renderStep(`搜索文件 "${glob.input.pattern}"`, "card-search_outlined");
    }
    case "Grep": {
      const grep = content as GrepToolUseMessageContent;
      return _renderStep(`搜索内容 "${grep.input.pattern}"`, "doc-search_outlined");
    }
    case "WebFetch": {
      const wf = content as WebFetchToolUseMessageContent;
      return _renderStep(`读取网页 "${wf.input.url}"`, "language_outlined");
    }
    case "WebSearch": {
      const ws = content as WebSearchToolUseMessageContent;
      return _renderStep(`搜索 "${ws.input.query}"`, "search_outlined");
    }
    case "Read": {
      const read = content as ReadToolUseMessageContent;
      return _renderStep(`读取文件 "${read.input.file_path}"`, "file-link-bitable_outlined");
    }
    case "Write": {
      const write = content as WriteToolUseMessageContent;
      return _renderStep(`写入文件 "${write.input.file_path}"`, "edit_outlined");
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

/** Create a step div element with icon and text. */
function _renderStep(text: string, iconToken: string): DivElement {
  return {
    tag: "div",
    icon: {
      tag: "standard_icon",
      token: iconToken,
      color: "grey",
    },
    text: {
      tag: "plain_text",
      text_color: "grey",
      text_size: "notation",
      content: text,
    },
  };
}

/** Build a collapsible panel for a phase. */
function _createPhasePanel(
  phase: PhaseDef,
  isActive: boolean,
  streaming: boolean,
  stepElements: DivElement[],
): CollapsiblePanel {
  const stepCount = stepElements.length;

  return {
    tag: "collapsible_panel",
    expanded: streaming && isActive,
    border: {
      color: isActive && streaming ? "blue-300" : "grey-300",
      corner_radius: "6px",
    },
    vertical_spacing: "2px",
    header: {
      title: {
        tag: "plain_text",
        text_color: isActive && streaming ? "blue" : "grey",
        text_size: "notation",
        content:
          streaming && isActive
            ? `${phase.activeLabel} ${stepCount}步`
            : `${phase.label} ${stepCount}步`,
      },
      icon: {
        tag: "standard_icon",
        token: phase.iconToken,
        color: isActive && streaming ? "blue" : "grey",
      },
      icon_position: "right",
      icon_expanded_angle: 90,
    },
    elements: stepElements,
  };
}

/**
 * Render assistant message content as a Feishu interactive card.
 * @param messageContent - Array of content blocks (thinking, tool_use, text).
 * @param options - Rendering options (streaming mode, session ID for stop button).
 * @returns Feishu Card object for API payload.
 */
export async function renderMessageCard(
  messageContent: AssistantMessage["content"],
  {
    streaming,
    uploadImage,
    sessionId,
  }: {
    streaming: boolean;
    sessionId?: string;
    uploadImage: UploadImageFn;
  },
): Promise<Card> {
  // Group tool_use steps by phase, preserving first-appearance order
  const phaseSteps = new Map<string, DivElement[]>();
  const phaseOrder: string[] = [];

  for (const content of messageContent) {
    if (content.type !== "tool_use") continue;

    const step = _createStepFromTool(content);
    const phaseKey = _classifyToolName(content.name);

    if (!phaseSteps.has(phaseKey)) {
      phaseSteps.set(phaseKey, []);
      phaseOrder.push(phaseKey);
    }
    phaseSteps.get(phaseKey)!.push(step);
  }

  // Determine which phase is currently active (last tool call in streaming)
  const toolCalls = messageContent.filter(
    (c): c is ToolUseMessageContent => c.type === "tool_use",
  );
  const activePhaseKey = streaming
    ? _classifyToolName(toolCalls[toolCalls.length - 1]?.name ?? "")
    : null;

  const bodyElements: Card["body"]["elements"] = [];

  // Build phase panels in order of first tool appearance
  for (const phaseKey of phaseOrder) {
    const phase = PHASES.find((p) => p.key === phaseKey)!;
    const steps = phaseSteps.get(phaseKey)!;
    bodyElements.push(
      _createPhasePanel(phase, phaseKey === activePhaseKey, streaming, steps),
    );
  }

  // Card summary text
  const totalSteps = toolCalls.length;
  const summary =
    streaming && activePhaseKey
      ? `${PHASES.find((p) => p.key === activePhaseKey)!.activeLabel} ${totalSteps}步`
      : totalSteps > 0
        ? `完成 ${totalSteps}步`
        : "";

  const card: Card = {
    schema: "2.0",
    config: {
      streaming_mode: true,
      enable_forward: true,
      enable_forward_interaction: true,
      update_multi: true,
      width_mode: "fill",
      summary: { content: summary },
    },
    body: { elements: bodyElements },
  };

  // Final answer markdown (only when streaming is finished)
  if (!streaming) {
    const lastText = messageContent.findLast((c) => c.type === "text");
    if (lastText) {
      const markdown = await _uploadMessageResource(lastText.text, { uploadImage });
      card.config!.summary.content = markdown;
      card.body.elements.push({ tag: "markdown", content: markdown });
    }
  }

  // Empty-body fallback (should not happen in practice)
  if (card.body.elements.length === 0) {
    card.body.elements.push({ tag: "div", text: { tag: "plain_text", content: "" } });
  }

  // Streaming-only footer: stop button + ellipsis indicator
  if (streaming) {
    if (sessionId) {
      card.body.elements.push({
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "中止", text_color: "white" },
            type: "danger",
            value: { action: "stop_task", session_id: sessionId },
          },
        ],
        layout: "flow",
      } satisfies ActionElement);
    }
    card.body.elements.push({
      tag: "div",
      icon: { tag: "standard_icon", token: "more_outlined", color: "grey" },
    });
  }

  _trimCardElements(card);
  return card;
}

/** Trim oldest step elements until the card fits Feishu's limit. */
function _trimCardElements(card: Card) {
  let count = _countElements(card);
  const panels = card.body.elements.filter(
    (e): e is CollapsiblePanel => e.tag === "collapsible_panel",
  );
  if (panels.length === 0 || count <= MAX_FEISHU_CARD_ELEMENTS) return;

  for (const panel of panels) {
    while (panel.elements.length > 0 && count > MAX_FEISHU_CARD_ELEMENTS) {
      const removed = panel.elements.shift();
      if (removed) count -= _countElements(removed);
    }
  }
}

function _countElements(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const item = value as Record<string, unknown>;
  const self = typeof item.tag === "string" ? 1 : 0;
  return Object.values(item).reduce<number>(
    (acc, child) =>
      acc +
      (Array.isArray(child)
        ? child.reduce((s, e) => s + _countElements(e), 0)
        : _countElements(child)),
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

/**
 * Regex pattern for matching markdown tables.
 * Matches: header row, separator row, and one or more data rows.
 */
const MARKDOWN_TABLE_REGEX =
  /^\|.+\|[ \t]*\n\|[\s:|-]+\|[ \t]*\n(?:\|.+\|[ \t]*\n?)+/gm;

/**
 * Split markdown content into multiple chunks, each containing at most a specified
 * number of tables. Used to work around Feishu's limit of 5 table components per card.
 *
 * @param markdown - The markdown content to split.
 * @param maxTables - Maximum number of tables per chunk (default: 5).
 * @returns Array of markdown strings, each with at most maxTables tables.
 */
export function splitMarkdownByTables(
  markdown: string,
  maxTables: number = 5,
): string[] {
  const tables = markdown.match(MARKDOWN_TABLE_REGEX);
  if (!tables || tables.length <= maxTables) {
    return [markdown];
  }

  const tablePositions: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  const regex = new RegExp(MARKDOWN_TABLE_REGEX.source, "gm");
  while ((match = regex.exec(markdown)) !== null) {
    tablePositions.push({
      start: match.index,
      end: match.index + match[0].length,
    });
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
