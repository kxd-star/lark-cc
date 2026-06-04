/** AgentEvent types that drive the RunState state machine. */
export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError?: boolean }
  | { type: 'error'; message: string; terminationReason?: string }
  | { type: 'done'; terminationReason?: string };

export type ToolStatus = 'running' | 'done' | 'error';

export interface ToolEntry {
  id: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  output?: string;
}

export type Block =
  | { kind: 'text'; content: string; streaming: boolean }
  | { kind: 'tool'; tool: ToolEntry };

export type FooterStatus = 'thinking' | 'tool_running' | 'streaming' | null;
export type Terminal = 'running' | 'done' | 'interrupted' | 'error' | 'idle_timeout';

/**
 * The phase of a reasoning segment, inferred from the tool call that follows it.
 * - search: 查找 — WebSearch / WebFetch
 * - analysis: 分析 — Read / Grep / Glob
 * - planning: 规划 — multi-tool orchestration / Agent / Task
 * - coding: 编码 — Edit / Write / NotebookEdit
 * - executing: 执行 — Bash
 * - thinking: 思考 — text output / done / unknown
 */
export type Phase = 'search' | 'analysis' | 'planning' | 'coding' | 'executing' | 'thinking';

export interface ReasoningSegment {
  id: number;
  content: string;
  phase: Phase;
  active: boolean;
}

export interface RunState {
  blocks: Block[];
  reasoning: {
    segments: ReasoningSegment[];
    activeSegmentId: number | null;
  };
  footer: FooterStatus;
  terminal: Terminal;
  errorMsg?: string;
  /** Set when terminal === 'idle_timeout' — how long claude was idle before
   * the watchdog gave up (so the message can say "N 分钟无响应"). */
  idleTimeoutMinutes?: number;
}

export const initialState: RunState = {
  blocks: [],
  reasoning: { segments: [], activeSegmentId: null },
  footer: 'thinking',
  terminal: 'running',
};

// ── Helpers ────────────────────────────────────────────

function closeStreamingText(blocks: Block[]): Block[] {
  return blocks.map((b) =>
    b.kind === 'text' && b.streaming ? { ...b, streaming: false } : b,
  );
}

/**
 * Map a tool name to the reasoning phase it implies.
 * Only called when a thinking segment is terminated by a tool_use event.
 */
function detectPhase(toolName: string): Phase {
  switch (toolName) {
    case 'WebSearch':
    case 'WebFetch':
      return 'search';
    case 'Read':
    case 'Grep':
    case 'Glob':
      return 'analysis';
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return 'coding';
    case 'Bash':
    case 'Monitor':
      return 'executing';
    case 'Agent':
    case 'Task':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskGet':
    case 'TaskList':
    case 'TaskOutput':
    case 'TaskStop':
    case 'AskUserQuestion':
    case 'CronCreate':
    case 'CronDelete':
    case 'CronList':
      return 'planning';
    default:
      return 'thinking';
  }
}

/** Finalize the active reasoning segment (set active=false), returns new reasoning object. */
function finalizeReasoning(
  reasoning: RunState['reasoning'],
  phaseOverride?: string,
): RunState['reasoning'] {
  if (reasoning.activeSegmentId === null) return reasoning;
  const phase = phaseOverride ? detectPhase(phaseOverride) : undefined;
  return {
    segments: reasoning.segments.map((s) =>
      s.id === reasoning.activeSegmentId
        ? { ...s, active: false, ...(phase ? { phase } : {}) }
        : s,
    ),
    activeSegmentId: null,
  };
}

// ── Reduce ─────────────────────────────────────────────

export function reduce(state: RunState, evt: AgentEvent): RunState {
  switch (evt.type) {
    case 'text': {
      const last = state.blocks[state.blocks.length - 1];
      if (last && last.kind === 'text' && last.streaming) {
        const next: Block = { ...last, content: last.content + evt.delta };
        return {
          ...state,
          blocks: [...state.blocks.slice(0, -1), next],
          reasoning: finalizeReasoning(state.reasoning),
          footer: 'streaming',
        };
      }
      return {
        ...state,
        blocks: [...state.blocks, { kind: 'text', content: evt.delta, streaming: true }],
        reasoning: finalizeReasoning(state.reasoning),
        footer: 'streaming',
      };
    }

    case 'thinking': {
      // Append to active segment if one is streaming
      if (state.reasoning.activeSegmentId !== null) {
        return {
          ...state,
          reasoning: {
            segments: state.reasoning.segments.map((s) =>
              s.id === state.reasoning.activeSegmentId
                ? { ...s, content: s.content + evt.delta }
                : s,
            ),
            activeSegmentId: state.reasoning.activeSegmentId,
          },
          footer: 'thinking',
        };
      }
      // Start a new segment
      const newId = state.reasoning.segments.length;
      return {
        ...state,
        reasoning: {
          segments: [
            ...state.reasoning.segments,
            { id: newId, content: evt.delta, phase: 'thinking' as Phase, active: true },
          ],
          activeSegmentId: newId,
        },
        footer: 'thinking',
      };
    }

    case 'tool_use': {
      const tool: ToolEntry = {
        id: evt.id,
        name: evt.name,
        input: evt.input,
        status: 'running',
      };
      return {
        ...state,
        blocks: [...closeStreamingText(state.blocks), { kind: 'tool', tool }],
        reasoning: finalizeReasoning(state.reasoning, evt.name),
        footer: 'tool_running',
      };
    }

    case 'tool_result': {
      const blocks = state.blocks.map((b) => {
        if (b.kind !== 'tool' || b.tool.id !== evt.id) return b;
        return {
          ...b,
          tool: {
            ...b.tool,
            status: evt.isError ? ('error' as const) : ('done' as const),
            output: evt.output,
          },
        };
      });
      return { ...state, blocks };
    }

    case 'error': {
      const terminal =
        evt.terminationReason === 'interrupted'
          ? 'interrupted'
          : evt.terminationReason === 'timeout'
            ? 'idle_timeout'
            : 'error';
      return {
        ...state,
        reasoning: finalizeReasoning(state.reasoning),
        terminal,
        errorMsg: terminal === 'error' ? evt.message : state.errorMsg,
        footer: null,
      };
    }

    case 'done': {
      const terminal =
        evt.terminationReason === 'interrupted'
          ? 'interrupted'
          : evt.terminationReason === 'timeout'
            ? 'idle_timeout'
            : 'done';
      return {
        ...state,
        blocks: closeStreamingText(state.blocks),
        reasoning: finalizeReasoning(state.reasoning),
        terminal,
        footer: null,
      };
    }

    default:
      return state;
  }
}

// ── Terminal helpers ───────────────────────────────────

export function markInterrupted(state: RunState): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: finalizeReasoning(state.reasoning),
    terminal: 'interrupted',
    footer: null,
  };
}

export function markIdleTimeout(state: RunState, minutes: number): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: finalizeReasoning(state.reasoning),
    terminal: 'idle_timeout',
    footer: null,
    idleTimeoutMinutes: minutes,
  };
}

export function finalizeIfRunning(state: RunState): RunState {
  if (state.terminal !== 'running') return state;
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: finalizeReasoning(state.reasoning),
    terminal: 'done',
    footer: null,
  };
}
