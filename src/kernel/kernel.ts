import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { FeishuMessageChannel } from "@/community/feishu";
import * as feishuMessagingSchema from "@/community/feishu/messaging/data";
import { DataConnection } from "@/data";
import type { AssistantMessage, UserMessage } from "@/shared";
import {
  config,
  createLogger,
  extractTextContent,
  uuid,
  type CardActionPayload,
  type InboundMessageTaskPayload,
  type ScheduledTaskPayload,
} from "@/shared";

import { HonoServer } from "../server";

import { MultiChannelMessageGateway } from "./messaging";
import { SessionManager } from "./sessioning";
import * as sessioningSchema from "./sessioning/data";
import { TaskDispatcher } from "./tasking";
import * as taskingSchema from "./tasking/data";

/**
 * The kernel is the main entry point for the agentara application.
 * Lazy-creation singleton: the instance is created on first `getInstance()`.
 */
class Kernel {
  private _logger = createLogger("kernel");
  private _database!: DataConnection;
  private _sessionManager!: SessionManager;
  private _taskDispatcher!: TaskDispatcher;
  private _messageGateway!: MultiChannelMessageGateway;
  private _honoServer!: HonoServer;

  constructor() {
    this._initDatabase();
    this._initSessionManager();
    this._initTaskDispatcher();
    this._initMessageGateway();
    this._initServer();
    this._registerShutdown();
  }

  private _registerShutdown(): void {
    const killClaude = () => {
      try {
        if (process.platform === "win32") {
          Bun.spawnSync(["taskkill", "/F", "/IM", "claude.exe"], {});
        } else {
          Bun.spawnSync(["pkill", "-9", "claude"], {});
        }
        this._logger.info("killed orphaned Claude processes on shutdown");
      } catch {
        // may fail if no claude processes exist
      }
    };
    process.on("SIGTERM", killClaude);
    process.on("SIGINT", killClaude);
    process.on("exit", killClaude);
  }

  get database(): DataConnection {
    return this._database;
  }

  get sessionManager(): SessionManager {
    return this._sessionManager;
  }

  get taskDispatcher(): TaskDispatcher {
    return this._taskDispatcher;
  }

  get messageGateway(): MultiChannelMessageGateway {
    return this._messageGateway;
  }

  get honoServer(): HonoServer {
    return this._honoServer;
  }

  private _initDatabase(): void {
    this._database = new DataConnection({
      ...taskingSchema,
      ...sessioningSchema,
      ...feishuMessagingSchema,
    });
  }

  private _initSessionManager(): void {
    this._sessionManager = new SessionManager(this._database.db);
  }

  private _initServer(): void {
    this._honoServer = new HonoServer();
  }

  private _initTaskDispatcher(): void {
    this._taskDispatcher = new TaskDispatcher({
      db: this._database.db,
    });
    this._taskDispatcher.route(
      "inbound_message",
      this._handleInboundMessageTask,
    );
    this._taskDispatcher.route("scheduled_task", this._handleScheduledTask);
  }

  private _initMessageGateway(): void {
    this._messageGateway = new MultiChannelMessageGateway(this._database.db);
    for (const channel of config.messaging.channels) {
      this._messageGateway.registerChannel(
        new FeishuMessageChannel(
          channel.id,
          {
            chatId: channel.params.chat_id!,
            appId: channel.params.app_id!,
            appSecret: channel.params.app_secret!,
          },
          this._database.db,
        ),
      );
    }
    this._messageGateway.on("message:inbound", this._handleInboundMessage);
    this._messageGateway.on("message:recalled", this._handleMessageRecall);
    this._messageGateway.on("card:action", this._handleCardAction);
  }

  /**
   * Start the kernel.
   */
  async start(): Promise<void> {
    await this._sessionManager.start();
    await this._taskDispatcher.start();
    await this._honoServer.start();
    await this._messageGateway.start();
  }

  private _handleInboundMessage = async (message: UserMessage) => {
    const text = extractTextContent(message).trim();

    // Handle /stop command
    if (text === "/stop") {
      await this._handleStopCommand(message);
      return;
    }

    const task: InboundMessageTaskPayload = {
      type: "inbound_message",
      message,
    };
    await this._taskDispatcher.dispatch(message.session_id, task);
  };

  private _handleStopCommand = async (message: UserMessage) => {
    const sessionId = message.session_id;
    const runningTaskId =
      this._taskDispatcher.getRunningTaskForSession(sessionId);

    if (runningTaskId) {
      await this._taskDispatcher.deleteTask(runningTaskId);
      await this._messageGateway.replyMessage(message.id, {
        role: "assistant",
        session_id: sessionId,
        content: [{ type: "text", text: "Task stopped." }],
      });
    } else {
      await this._messageGateway.replyMessage(message.id, {
        role: "assistant",
        session_id: sessionId,
        content: [{ type: "text", text: "No running task found." }],
      });
    }
  };

  private _handleMessageRecall = async (
    messageId: string,
    channelId: string,
  ) => {
    const taskId = this._taskDispatcher.getTaskByMessageId(messageId);
    if (taskId) {
      await this._taskDispatcher.deleteTask(taskId);
      this._logger.info(
        { message_id: messageId, task_id: taskId, channel_id: channelId },
        "task stopped due to message recall",
      );
    }
  };

  private _handleCardAction = async (payload: CardActionPayload) => {
    if (payload.action !== "stop_task") return;

    const { sessionId, messageId } = payload;
    const taskId = this._taskDispatcher.getRunningTaskForSession(sessionId);

    if (taskId) {
      await this._taskDispatcher.deleteTask(taskId);
      this._logger.info(
        { session_id: sessionId, task_id: taskId, message_id: messageId },
        "task cancelled via card action",
      );
    }

    // Update the card to show cancelled state
    await this._messageGateway.updateMessageContent(
      {
        id: messageId,
        session_id: sessionId,
        role: "assistant",
        content: [{ type: "text", text: " ⚠️ 任务已中止" }],
      },
      { streaming: false },
    );
  };

  private static readonly _CONTEXT_FILE = "context.md";
  private static readonly _LIVENESS_TIMEOUT_MS = 5 * 60 * 1000;
  private static readonly _LIVENESS_CHECK_INTERVAL_MS = 30_000;

  /**
   * Swap in per-source context: reads `memory/<source>/context.md` and writes
   * it to `memory/context.md` so the session's CLAUDE.md @import picks it up.
   * Creates an empty file if the source file doesn't exist yet.
   */
  private _swapContextIn(source: string | undefined): void {
    if (!source) return;
    const contextPath = join(config.paths.memory, source, Kernel._CONTEXT_FILE);
    const sharedPath = join(config.paths.memory, Kernel._CONTEXT_FILE);
    let content = "";
    if (existsSync(contextPath)) {
      content = readFileSync(contextPath, "utf-8");
    }
    writeFileSync(sharedPath, content, "utf-8");
    this._logger.info(
      { source },
      `Swapped context into memory/context.md (${content.length} chars)`,
    );
  }

  /**
   * Swap out per-source context: reads the session's updated `memory/context.md`
   * and persists it back to `memory/<source>/context.md`.
   */
  private _swapContextOut(source: string | undefined): void {
    if (!source) return;
    const sharedPath = join(config.paths.memory, Kernel._CONTEXT_FILE);
    const contextPath = join(config.paths.memory, source, Kernel._CONTEXT_FILE);
    if (!existsSync(sharedPath)) {
      this._logger.warn({ source }, "context.md not found on swap-out");
      return;
    }
    const content = readFileSync(sharedPath, "utf-8");
    mkdirSync(dirname(contextPath), { recursive: true });
    writeFileSync(contextPath, content, "utf-8");
    this._logger.info(
      { source },
      `Swapped context back to memory/${source}/context.md (${content.length} chars)`,
    );
  }

  private _handleInboundMessageTask = async (
    taskId: string,
    sessionId: string,
    payload: InboundMessageTaskPayload,
    signal?: AbortSignal,
  ) => {
    const inboundMessage = payload.message;
    const session = await this._sessionManager.resolveSession(sessionId, {
      channelId: inboundMessage.channel_id,
      firstMessage: inboundMessage,
    });
    let contents: AssistantMessage["content"] = [
      {
        type: "thinking",
        thinking: "Thinking...",
      },
    ];
    const outboundMessage = await this._messageGateway.replyMessage(
      inboundMessage.id,
      {
        role: "assistant",
        session_id: session.id,
        content: contents,
      },
      {
        streaming: true,
      },
    );
    contents = [];
    // Swap in per-source context before spawning claude subprocess
    this._swapContextIn(inboundMessage.source);

    // Liveness timeout: notify user if no output for 5 minutes
    let lastActivity = Date.now();
    let livenessNotified = false;
    const livenessTimer = setInterval(async () => {
      if (
        Date.now() - lastActivity > Kernel._LIVENESS_TIMEOUT_MS &&
        !livenessNotified
      ) {
        livenessNotified = true;
        try {
          await this._messageGateway.postMessage({
            role: "assistant",
            session_id: session.id,
            content: [{ type: "text", text: "⏳ 执行中，请稍候…" }],
          });
        } catch {
          // best-effort notification
        }
      }
    }, Kernel._LIVENESS_CHECK_INTERVAL_MS);

    try {
      const stream = await session.stream(inboundMessage, { signal });
      for await (const message of stream) {
        if (message.role === "assistant") {
          contents.push(...message.content);
          lastActivity = Date.now();
          livenessNotified = false;
          await this._messageGateway.updateMessageContent(
            { ...outboundMessage, content: contents },
            {
              streaming: true,
            },
          );
        }
      }
    } catch (err) {
      if (signal?.aborted) {
        this._logger.info(
          { session_id: session.id },
          "task aborted by user",
        );
      } else {
        throw err;
      }
    } finally {
      clearInterval(livenessTimer);
      // Persist context back after session completes
      this._swapContextOut(inboundMessage.source);
      await this._messageGateway.updateMessageContent(
        { ...outboundMessage, content: contents },
        {
          streaming: false,
        },
      );
    }
  };

  private _handleScheduledTask = async (
    _taskId: string,
    sessionId: string,
    payload: ScheduledTaskPayload,
    signal?: AbortSignal,
  ) => {
    const payload_without_instruction: { instruction?: string } = {
      ...payload,
    };
    const defaultChannelId = config.messaging.default_channel_id;
    const userMessage: UserMessage = {
      id: uuid(),
      role: "user",
      session_id: sessionId,
      channel_id: defaultChannelId,
      content: [
        {
          type: "text",
          text: `> This message is automatically triggered by a scheduled task.
> The time is now ${new Date().toString()}.
> Cron expression: \`${JSON.stringify(payload_without_instruction)}\`

${payload.instruction}`,
        },
      ],
    };
    const session = await this._sessionManager.resolveSession(sessionId, {
      channelId: userMessage.channel_id,
      firstMessage: userMessage,
    });
    delete payload_without_instruction.instruction;
    const assistantMessage = await session.run(userMessage, { signal });
    if (extractTextContent(assistantMessage).includes("[SKIPPED]")) {
      return;
    }
    await this._messageGateway.postMessage(assistantMessage);
  };
}

export const kernel = new Kernel();
