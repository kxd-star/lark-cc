import { describe, expect, test } from "bun:test";

import { renderMessageCard } from "@/community/feishu/messaging/message-renderer";
import type {
  ActionElement,
  CollapsiblePanel,
} from "@/community/feishu/messaging/types";

function countElements(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const item = value as Record<string, unknown>;
  const self = typeof item.tag === "string" ? 1 : 0;
  return Object.values(item).reduce<number>(
    (count, child) =>
      count +
      (Array.isArray(child)
        ? child.reduce<number>((sum, entry) => sum + countElements(entry), 0)
        : countElements(child)),
    self,
  );
}

describe("renderMessageCard", () => {
  test("keeps final cards within Feishu's official 200 element limit", async () => {
    const card = await renderMessageCard(
      [
        ...Array.from({ length: 100 }, (_, i) => ({
          type: "tool_use" as const,
          id: `tool-${i}`,
          name: "Bash",
          input: { command: `echo ${i}` },
        })),
        { type: "text", text: "done" } as const,
      ],
      {
        streaming: false,
        uploadImage: async () => "image-key",
      },
    );

    // All 100 Bash steps should be grouped under the "execute" phase panel
    const executePanel = card.body.elements.find(
      (element): element is CollapsiblePanel =>
        element.tag === "collapsible_panel" &&
        element.header?.title?.content?.startsWith("执行"),
    );

    expect(countElements(card)).toBeLessThanOrEqual(200);
    expect(executePanel?.tag).toBe("collapsible_panel");
    expect(executePanel?.elements.length).toBe(65);
  });

  test("groups tools by phase with Chinese labels", async () => {
    const card = await renderMessageCard(
      [
        {
          type: "tool_use" as const,
          id: "t1",
          name: "WebSearch",
          input: { query: "test" },
        },
        {
          type: "tool_use" as const,
          id: "t2",
          name: "Edit",
          input: { file_path: "test.ts", old_string: "a", new_string: "b" },
        },
        {
          type: "tool_use" as const,
          id: "t3",
          name: "Bash",
          input: { command: "echo ok" },
        },
      ],
      { streaming: true, uploadImage: async () => "" },
    );

    const panels = card.body.elements.filter(
      (e): e is CollapsiblePanel => e.tag === "collapsible_panel",
    );
    expect(panels.length).toBe(3);

    expect(panels[0]?.header?.title?.content).toContain("查找");
    expect(panels[1]?.header?.title?.content).toContain("编码");
    expect(panels[2]?.header?.title?.content).toContain("执行");
  });

  test("adds stop button and more indicator during streaming", async () => {
    const card = await renderMessageCard(
      [
        {
          type: "tool_use" as const,
          id: "t1",
          name: "Bash",
          input: { command: "echo ok" },
        },
      ],
      {
        streaming: true,
        sessionId: "session-1",
        uploadImage: async () => "",
      },
    );

    const actions = card.body.elements.filter(
      (e): e is ActionElement => e.tag === "action",
    );
    expect(actions.length).toBe(1);

    const action = actions[0]!;
    expect(action.actions[0]?.tag).toBe("button");
    expect(action.actions[0]?.value?.action).toBe("stop_task");
    expect(action.actions[0]?.value?.session_id).toBe("session-1");

    const moreIndicators = card.body.elements.filter(
      (e) =>
        e.tag === "div" &&
        e.icon?.tag === "standard_icon" &&
        e.icon.token === "more_outlined",
    );
    expect(moreIndicators.length).toBe(1);
  });

  test("no stop button when sessionId is not provided", async () => {
    const card = await renderMessageCard(
      [
        {
          type: "tool_use" as const,
          id: "t1",
          name: "Bash",
          input: { command: "echo ok" },
        },
      ],
      { streaming: true, uploadImage: async () => "" },
    );

    const actions = card.body.elements.filter((e) => e.tag === "action");
    expect(actions.length).toBe(0);
  });
});
