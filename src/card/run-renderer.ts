import type { Block, FooterStatus, Phase, ReasoningSegment, RunState, ToolEntry } from './run-state';
import { toolBodyMd, toolHeaderText } from './tool-render';

const REASONING_MAX = 1500;
const COLLAPSE_TOOL_THRESHOLD = 3;

interface ToolGroup {
  kind: 'tools';
  tools: ToolEntry[];
}
interface TextGroup {
  kind: 'text';
  content: string;
}
type Group = ToolGroup | TextGroup;

export interface RunCardRenderOptions {
  // eslint-disable-next-line no-unused-vars
  signCallback?: (action: string) => string;
}

/** Phase display config: Feishu standard_icon token, Chinese titles for active vs finalized. */
const PHASE_LABEL: Record<Phase, { iconToken: string; active: string; done: string }> = {
  search:    { iconToken: 'search_outlined',                  active: '查找中…',   done: '查找完毕' },
  analysis:  { iconToken: 'file-link-mindnote_outlined',      active: '分析中…',   done: '分析完成' },
  planning:  { iconToken: 'file-link-bitable_outlined',       active: '规划中…',   done: '规划完成' },
  coding:    { iconToken: 'edit_outlined',                    active: '编码中…',   done: '编码完成' },
  executing: { iconToken: 'computer_outlined',                active: '执行中…',   done: '执行完成' },
  thinking:  { iconToken: 'more_outlined',                    active: '思考中…',   done: '思考完成' },
};

export function renderCard(state: RunState, options: RunCardRenderOptions = {}): object {
  const elements: object[] = [];

  // Render each reasoning segment as its own collapsible panel.
  // Active segment → expanded; most recent 2 finalized → expanded; older → collapsed.
  const finalizedSegs: ReasoningSegment[] = [];
  let activeSeg: ReasoningSegment | undefined;
  for (const seg of state.reasoning.segments) {
    if (seg.active) activeSeg = seg;
    else finalizedSegs.push(seg);
  }
  for (const seg of finalizedSegs) {
    const isRecent = seg.id >= finalizedSegs.length - 2;
    elements.push(reasoningSegmentPanel(seg, isRecent));
  }
  if (activeSeg) {
    elements.push(reasoningSegmentPanel(activeSeg, true));
  }

  for (const group of groupBlocks(state.blocks)) {
    if (group.kind === 'text') {
      if (group.content.trim()) {
        elements.push(markdown(group.content));
      }
    } else {
      elements.push(...renderToolGroup(group.tools, state.terminal !== 'running'));
    }
  }

  if (state.terminal === 'interrupted') {
    elements.push(noteMd('_⏹ 已被中断_'));
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    elements.push(noteMd(`_⏱ ${mins} 分钟无响应,已自动终止_`));
  } else if (state.terminal === 'error' && state.errorMsg) {
    elements.push(noteMd(`⚠️ agent 失败：${state.errorMsg}`));
  } else if (state.terminal === 'done' && elements.length === 0) {
    elements.push(noteMd('_（未返回内容）_'));
  }

  if (state.terminal === 'running') {
    if (state.footer) elements.push(footerStatus(state.footer));
    elements.push(stopButton(options));
  }

  return {
    schema: '2.0',
    config: {
      streaming_mode: state.terminal === 'running',
      update_multi: true,
      summary: { content: summaryText(state) },
    },
    body: { elements },
  };
}

function* groupBlocks(blocks: Block[]): Generator<Group> {
  let toolBuf: ToolEntry[] = [];
  for (const b of blocks) {
    if (b.kind === 'tool') {
      toolBuf.push(b.tool);
    } else {
      if (toolBuf.length > 0) {
        yield { kind: 'tools', tools: toolBuf };
        toolBuf = [];
      }
      yield { kind: 'text', content: b.content };
    }
  }
  if (toolBuf.length > 0) yield { kind: 'tools', tools: toolBuf };
}

function renderToolGroup(tools: ToolEntry[], finalized: boolean): object[] {
  if (tools.length === 0) return [];
  if (tools.length < COLLAPSE_TOOL_THRESHOLD) {
    return tools.map((t) => toolPanel(t, false));
  }
  if (finalized) {
    return [collapsedToolSummary(tools, true)];
  }
  // Running: collapse prior tools, keep latest visible.
  const prior = tools.slice(0, -1);
  const latest = tools[tools.length - 1];
  const out: object[] = [];
  if (prior.length > 0) out.push(collapsedToolSummary(prior, false));
  if (latest) out.push(toolPanel(latest, true));
  return out;
}

/** Render a single reasoning segment as a collapsible panel with phase-specific icon and title. */
function reasoningSegmentPanel(seg: ReasoningSegment, expanded: boolean): object {
  const phase = PHASE_LABEL[seg.phase];
  const label = seg.active ? phase.active : phase.done;
  const color = seg.active ? 'blue' : 'grey';
  return {
    tag: 'collapsible_panel',
    expanded,
    border: { color, corner_radius: '6px' },
    vertical_spacing: '2px',
    header: {
      title: { tag: 'plain_text', text_color: color, text_size: 'notation', content: label },
      icon: { tag: 'standard_icon', token: phase.iconToken, color },
      icon_position: 'right',
      icon_expanded_angle: 90,
    },
    elements: [{ tag: 'markdown', content: truncate(seg.content, REASONING_MAX), text_size: 'notation' }],
  };
}

/**
 * Render N tool calls as a single collapsed panel. **Body content is dropped**
 * — only the per-tool header line (icon + name + short summary) is kept.
 *
 * Why no bodies: with full input/output panels nested, the serialized JSON
 * can easily exceed Feishu's per-element size limit (~30KB), causing 400
 * errors that abort the entire card stream. Tool details are still in the
 * file log; users who really need them can `/doctor` to inspect.
 *
 * The latest-running tool, when applicable, is rendered separately via
 * `toolPanel(latest, true)` so live observation isn't sacrificed.
 */
function collapsedToolSummary(tools: ToolEntry[], finalized: boolean): object {
  const suffix = finalized ? '（已结束）' : '';
  const headerList = tools.map((t) => `- ${toolHeaderText(t)}`).join('\n');
  return {
    tag: 'collapsible_panel',
    expanded: false,
    border: { color: 'blue', corner_radius: '6px' },
    vertical_spacing: '2px',
    padding: '8px 8px 8px 8px',
    header: {
      title: {
        tag: 'plain_text',
        text_color: 'grey',
        text_size: 'notation',
        content: `☕ ${tools.length} 个工具调用${suffix}`,
      },
      icon: { tag: 'standard_icon', token: 'more_outlined', color: 'grey' },
      icon_position: 'right',
      icon_expanded_angle: 90,
    },
    elements: [{ tag: 'markdown', content: headerList, text_size: 'notation' }],
  };
}

/** Map tool name to Feishu standard_icon token. */
function _toolIconToken(name: string): string {
  switch (name) {
    case 'Agent':
    case 'Task':       return 'robot_outlined';
    case 'Bash':       return 'computer_outlined';
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': return 'edit_outlined';
    case 'Read':       return 'file-link-bitable_outlined';
    case 'Glob':       return 'card-search_outlined';
    case 'Grep':       return 'doc-search_outlined';
    case 'WebSearch':  return 'search_outlined';
    case 'WebFetch':   return 'language_outlined';
    case 'Skill':
    case 'ToolSearch': return 'file-link-mindnote_outlined';
    default:           return 'setting-inter_outlined';
  }
}

function toolPanel(tool: ToolEntry, expanded: boolean): object {
  const color = tool.status === 'error' ? 'red' : 'grey';
  return {
    tag: 'collapsible_panel',
    expanded,
    border: { color, corner_radius: '6px' },
    vertical_spacing: '2px',
    header: {
      title: { tag: 'markdown', content: toolHeaderText(tool), text_size: 'notation' },
      icon: { tag: 'standard_icon', token: _toolIconToken(tool.name), color },
      icon_position: 'right',
      icon_expanded_angle: 90,
    },
    elements: [{ tag: 'markdown', content: toolBodyMd(tool) || '_无输出_', text_size: 'notation' }],
  };
}

function markdown(content: string): object {
  return { tag: 'markdown', content };
}

function noteMd(content: string): object {
  return { tag: 'markdown', content, text_size: 'notation' };
}

function stopButton(options: RunCardRenderOptions): object {
  const value: Record<string, unknown> = { cmd: 'stop' };
  if (options.signCallback) {
    value.__bridge_cb = true;
    value.bridge_token = options.signCallback('stop');
  }
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: '⏹ 终止' },
    type: 'danger',
    behaviors: [{ type: 'callback', value }],
  };
}

const FOOTER_LABEL: Record<Exclude<FooterStatus, null>, { text: string; token: string }> = {
  thinking:     { text: '思考中…',      token: 'more_outlined' },
  tool_running: { text: '调用工具中…', token: 'computer_outlined' },
  streaming:    { text: '输出中…',      token: 'edit_outlined' },
};

function footerStatus(status: Exclude<FooterStatus, null>): object {
  const f = FOOTER_LABEL[status];
  return {
    tag: 'div',
    icon: { tag: 'standard_icon', token: f.token, color: 'grey' },
    text: { tag: 'plain_text', text_color: 'grey', text_size: 'notation', content: f.text },
  };
}

function summaryText(state: RunState): string {
  if (state.terminal === 'interrupted') return '已中断';
  if (state.terminal === 'idle_timeout') return '已超时';
  if (state.terminal === 'error') return '出错';
  if (state.terminal === 'done') return '已完成';
  if (state.footer === 'tool_running') return '正在调用工具';
  if (state.footer === 'streaming') return '正在输出';
  return '思考中';
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
