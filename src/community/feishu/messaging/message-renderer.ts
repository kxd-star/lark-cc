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

import type { Card, CollapsiblePanel, DivElement } from "./types";

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
    match: (n) => ["WebSearch", "WebFetch", "Glob", "Grep", "Read"].includes(n),
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

function _classifyToolName(toolName: string): string {
  return PHASES.find((p) => p.match(toolName))?.key ?? "execute";
}

function _renderStep(text: string, iconToken: string): DivElement {
  return {
    tag: "div",
    icon: { tag: "standard_icon", token: iconToken, color: "grey" },
    text: {
      tag: "plain_text",
      text_color: "grey",
      text_size: "notation",
      content: text,
    },
  };
}

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
      return _renderStep(`加载 "${skill.input.skill}"`, "file-link-mindnote_outlined");
    }
    default:
      return _renderStep(content.name, "setting-inter_outlined");
  }
}

function _createPhasePanel(
  phase: PhaseDef,
  isActive: boolean,
  streaming: boolean,
  stepElements: DivElement[],
): CollapsiblePanel {
  const stepCount = stepElements.length;
  const showActive = streaming && isActive;

  return {
    tag: "collapsible_panel",
    expanded: showActive,
    border: {
      color: showActive ? "blue-300" : "grey-300",
      corner_radius: "6px",
    },
    vertical_spacing: "2px",
    header: {
      title: {
        tag: "plain_text",
        text_color: showActive ? "blue" : "grey",
        text_size: "notation",
        content: showActive
          ? `${phase.activeLabel} ${stepCount}步`
          : `${phase.label} ${stepCount}步`,
      },
      icon: {
        tag: "standard_icon",
        token: phase.iconToken,
        color: showActive ? "blue" : "grey",
      },
      icon_position: "right",
      icon_expanded_angle: 90,
    },
    elements: stepElements,
  };
}

/**
 * Render assistant message content as a Feishu interactive card (CardKit 2.0).
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

  const toolCalls = messageContent.filter(
    (c): c is ToolUseMessageContent => c.type === "tool_use",
  );
  const activePhaseKey = streaming
    ? _classifyToolName(toolCalls[toolCalls.length - 1]?.name ?? "")
    : null;

  const bodyElements: Card["body"]["elements"] = [];

  for (const phaseKey of phaseOrder) {
    const phase = PHASES.find((p) => p.key === phaseKey)!;
    const steps = phaseSteps.get(phaseKey)!;
    bodyElements.push(
      _createPhasePanel(phase, phaseKey === activePhaseKey, streaming, steps),
    );
  }

  if (!streaming) {
    const lastText = messageContent.findLast((c) => c.type === "text");
    if (lastText) {
      const markdown = await _uploadMessageResource(lastText.text, { uploadImage });
      bodyElements.push({ tag: "markdown", content: markdown });
    }
  }

  if (bodyElements.length === 0) {
    bodyElements.push({ tag: "div", text: { tag: "plain_text", content: "" } });
  }

  if (streaming) {
    if (sessionId) {
      bodyElements.push({
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
      });
    }
    bodyElements.push({
      tag: "div",
      icon: { tag: "standard_icon", token: "more_outlined", color: "grey" },
    });
  }

  const totalSteps = toolCalls.length;
  const summary = streaming && activePhaseKey
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

  if (!streaming) {
    const lastText = messageContent.findLast((c) => c.type === "text");
    if (lastText) {
      const clean = lastText.text.replace(/!\[.*?\]\(.*?\)/g, "").substring(0, 150).trim();
      if (clean) card.config!.summary.content = clean;
    }
  }

  _trimCardElements(card);
  return card;
}

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
