import fs from "node:fs";
import nodePath from "node:path";

import { Client, EventDispatcher, WSClient } from "@larksuiteoapi/node-sdk";
import { eq } from "drizzle-orm";
import EventEmitter from "eventemitter3";

import type { DrizzleDB } from "@/data";
import type { Logger, TextMessageContent } from "@/shared";
import {
  config,
  createLogger,
  uuid,
  type AssistantMessage,
  type CardActionPayload,
  type MessageChannel,
  type MessageChannelEventTypes,
  type UserMessage,
} from "@/shared";

import { feishuThreads } from "./data";
import { renderMessageCard, splitMarkdownByTables } from "./message-renderer";
import type { MessageReceiveEventData } from "./types";
import { convertPostToMarkdown } from "./utils";

function _isFeishuBadRequestError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }

  const candidate = err as {
    status?: number;
    code?: number | string;
    response?: {
      status?: number;
      data?: {
        code?: number | string;
      };
    };
  };

  return (
    candidate.status === 400 ||
    candidate.code === 400 ||
    candidate.response?.status === 400 ||
    candidate.response?.data?.code === 400
  );
}

/** Message channel implementation for Feishu (Lark) chat platform. */
export class FeishuMessageChannel
  extends EventEmitter<MessageChannelEventTypes>
  implements MessageChannel
{
  readonly type = "feishu";

  private _inboundClient: WSClient;
  private _client: Client;
  private _db: DrizzleDB;
  private _lastChatId: string | null = null;
  private _failedCardUpdateMessages = new Set<string>();
  private _logger: Logger;

  /**
   * Create a Feishu message channel.
   * @param config - Feishu app credentials (defaults to env vars).
   * @param db - Drizzle database instance for persisting thread-to-session mappings.
   */
  constructor(
    readonly id: string,
    readonly config: {
      chatId: string;
      appId: string;
      appSecret: string;
    },
    db: DrizzleDB,
  ) {
    super();
    this.id = id;
    if (!config.appId || !config.appSecret) {
      throw new Error("Feishu app ID and secret are required");
    }
    this._db = db;
    this._logger = createLogger("feishu-message-channel");
    this._inboundClient = new WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });
    this._client = new Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });
  }

  /** Start listening for inbound messages via WebSocket. */
  async start() {
    await this._inboundClient.start({
      eventDispatcher: new EventDispatcher({}).register({
        "im.message.receive_v1": this._handleMessageReceive,
        "im.message.recalled_v1": this._handleMessageRecall,
        // card.action.trigger is supported at runtime via WebSocket
        "card.action.trigger": this._handleCardAction,
      // eslint-disable-next-line no-unused-vars, @typescript-eslint/no-explicit-any
      } as Record<string, (data: any) => void | Promise<void>>),
    });
    this._startConnectionMonitor();
  }

  /** Periodically check and log WebSocket connection health. */
  private _connectionMonitorTimer: ReturnType<typeof setInterval> | undefined;
  private _lastWsState: string | undefined;

  private _startConnectionMonitor(): void {
    const check = () => {
      try {
        const info = this._inboundClient.getReconnectInfo();
        const nextIn = info.nextConnectTime
          ? Math.max(0, info.nextConnectTime - Date.now())
          : 0;
        const state = nextIn > 0 ? `reconnecting (next attempt in ${Math.round(nextIn / 1000)}s)` : "connected";
        if (state !== this._lastWsState) {
          this._lastWsState = state;
          this._logger.info({ reconnect_info: info }, `WebSocket state: ${state}`);
        }
      } catch {
        // getReconnectInfo may throw if WS not fully initialized
      }
    };
    check();
    this._connectionMonitorTimer = setInterval(check, 30_000);
  }

  /** Reply to a message, establishing a reply chain so the user can quote it. */
  async replyMessage(
    messageId: string,
    message: Omit<AssistantMessage, "id">,
    { streaming = true }: { streaming?: boolean } = {},
  ): Promise<AssistantMessage> {
    const { firstMessageContent, remainingChunks } = this._prepareMessageContent(
      message.content,
      streaming,
    );

    const card = await renderMessageCard(firstMessageContent, {
      streaming,
      sessionId: message.session_id,
      uploadImage: this.uploadImage.bind(this),
    });
    if (!streaming) {
      this._logOutboundMessage(message.session_id, message.content);
    }
    const { data: replyResult } = await this._client.im.message.reply({
      path: {
        message_id: messageId,
      },
      data: {
        msg_type: "interactive",
        content: JSON.stringify(card),
        reply_in_thread: false,
      },
    });
    if (!replyResult) {
      throw new Error("Failed to reply message");
    }

    const { thread_id: threadId } = replyResult;
    const sessionId = message.session_id;
    if (threadId) {
      this._mapThreadToSession(threadId, sessionId);
    }

    await this._sendRemainingChunks(replyResult.message_id!, remainingChunks);

    const assistantMessage = message as AssistantMessage;
    assistantMessage.id = replyResult.message_id!;

    if (!streaming) {
      const lastText = message.content.filter((c) => c.type === "text").pop();
      if (lastText?.type === "text") {
        await this._sendLocalFileAttachments(
          assistantMessage.id,
          lastText.text,
        );
      }
    }

    return assistantMessage;
  }

  async postMessage(
    message: Omit<AssistantMessage, "id">,
  ): Promise<AssistantMessage> {
    const { firstMessageContent, remainingChunks } = this._prepareMessageContent(
      message.content,
      false,
    );

    const card = await renderMessageCard(firstMessageContent, {
      streaming: false,
      sessionId: message.session_id,
      uploadImage: this.uploadImage.bind(this),
    });
    this._logOutboundMessage(message.session_id, message.content);
    const { data } = await this._client.im.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: this._lastChatId ?? this.config.chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
    if (!data) {
      throw new Error("Failed to post message");
    }
    const { message_id: messageId } = data;
    const assistantMessage = message as AssistantMessage;
    assistantMessage.id = messageId!;

    await this._sendRemainingChunks(assistantMessage.id, remainingChunks);

    const lastText = message.content.filter((c) => c.type === "text").pop();
    if (lastText?.type === "text") {
      await this._sendLocalFileAttachments(assistantMessage.id, lastText.text);
    }

    const emojis = [
      "思考中",
      "送你小红花",
      "送心",
      "灵光一现",
      "辛勤营业",
      "挥手",
    ];
    const { data: replyData } = await this._client.im.message.reply({
      path: {
        message_id: assistantMessage.id,
      },
      data: {
        content: JSON.stringify({
          type: "text",
          text: `[${emojis[Math.floor(Math.random() * emojis.length)]}] Reply here to continue the conversation`,
        }),
        msg_type: "text",
        reply_in_thread: false,
      },
    });
    if (replyData) {
      const { thread_id: threadId } = replyData;
      const sessionId = message.session_id;
      this._mapThreadToSession(threadId!, sessionId);
    }
    return assistantMessage;
  }

  /** Update the content of an existing Feishu message. */
  async updateMessageContent(
    message: AssistantMessage,
    { streaming = true }: { streaming?: boolean } = {},
  ): Promise<void> {
    if (this._failedCardUpdateMessages.has(message.id)) {
      return;
    }

    const { firstMessageContent, remainingChunks } = this._prepareMessageContent(
      message.content,
      streaming,
    );

    const card = await renderMessageCard(firstMessageContent, {
      streaming,
      sessionId: message.session_id,
      uploadImage: this.uploadImage.bind(this),
    });
    if (!streaming) {
      this._logOutboundMessage(message.session_id, message.content);
    }
    try {
      await this._client.im.message.patch({
        path: {
          message_id: message.id,
        },
        data: {
          content: JSON.stringify(card),
        },
      });
    } catch (err) {
      if (_isFeishuBadRequestError(err)) {
        this._failedCardUpdateMessages.add(message.id);
        this._logger.warn(
          { err, message_id: message.id, session_id: message.session_id },
          "Feishu card update failed with 400; sending fallback reply",
        );
        await this._replyUpdateFailureMessage(message.id);
        return;
      }
      throw err;
    }

    await this._sendRemainingChunks(message.id, remainingChunks);

    if (!streaming) {
      const lastText = message.content.filter((c) => c.type === "text").pop();
      if (lastText?.type === "text") {
        await this._sendLocalFileAttachments(message.id, lastText.text);
      }
    }
  }

  /**
   * Uploads an image to Feishu. Returns the key of the uploaded image.
   * @param path - The path to the image to upload.
   * @returns The key of the uploaded image.
   */
  async uploadImage(path: string): Promise<string> {
    const absPath = nodePath.join(config.paths.home, path);
    const file = fs.readFileSync(absPath);
    this._logger.info(`Uploading image ${absPath}`);
    const res = await this._client.im.v1.image.create({
      data: {
        image_type: "message",
        image: file,
      },
    });
    this._logger.info(
      `Uploaded image ${absPath} -> ${res?.image_key || "failed"}`,
    );
    if (res?.image_key) {
      return res.image_key;
    } else {
      throw new Error("Failed to upload image");
    }
  }

  /**
   * Uploads a file to Feishu. Returns the key of the uploaded file.
   * @param filePath - The path to the file relative to the home directory.
   * @returns The key of the uploaded file.
   */
  async uploadFile(filePath: string): Promise<string> {
    const absPath = nodePath.join(config.paths.home, filePath);
    const file = fs.createReadStream(absPath);
    const fileName = nodePath.basename(absPath);
    const ext = nodePath.extname(absPath).slice(1).toLowerCase();
    const fileTypeMap: Record<
      string,
      "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream"
    > = {
      opus: "opus",
      mp4: "mp4",
      pdf: "pdf",
      doc: "doc",
      docx: "doc",
      xls: "xls",
      xlsx: "xls",
      ppt: "ppt",
      pptx: "ppt",
    };
    const fileType = fileTypeMap[ext] ?? "stream";
    this._logger.info(`Uploading file ${absPath} (type: ${fileType})`);
    const res = await this._client.im.v1.file.create({
      data: {
        file_type: fileType,
        file_name: fileName,
        file,
      },
    });
    this._logger.info(
      `Uploaded file ${absPath} -> ${res?.file_key || "failed"}`,
    );
    if (res?.file_key) {
      return res.file_key;
    } else {
      throw new Error("Failed to upload file");
    }
  }

  /**
   * Downloads an image or a file from a message.
   * @param messageId - The ID of the message to download the resource from.
   * @param file_key - The key of the file to download.
   * @param file_name - The name of the file to download. If not provided, the file name will be inferred from the file key.
   * @returns The path to the downloaded file.
   */
  async downloadMessageResource(
    messageId: string,
    file_key: string,
    file_name?: string,
  ): Promise<string> {
    const { writeFile, headers } = await this._client.im.v1.messageResource.get(
      {
        path: {
          message_id: messageId,
          file_key,
        },
        params: {
          type: "file",
        },
      },
    );
    const metadata = JSON.parse(
      headers.get("inner_file_data_meta") as string,
    ) as {
      FileName: string;
      Mime: string;
    };
    const isImage = metadata.Mime.startsWith("image/");
    let dir = config.paths.uploads;
    if (isImage) {
      dir = nodePath.join(dir, "images");
    }
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    let filename: string;
    if (file_name) {
      filename = file_name;
    } else {
      filename = metadata.FileName === "image" ? file_key : metadata.FileName;
      if (metadata.Mime.startsWith("image/")) {
        filename += "." + metadata.Mime.split("/")[1];
      } else if (metadata.Mime === "audio/octet-stream") {
        filename += ".ogg";
      } else {
        filename += `.${metadata.Mime.split("/")[1]}`;
      }
    }
    const extname = nodePath.extname(filename);
    filename = filename.substring(0, filename.length - extname.length);
    if (fs.existsSync(nodePath.join(dir, filename + extname))) {
      let i = 1;
      while (fs.existsSync(nodePath.join(dir, filename + `-${i}` + extname))) {
        i++;
      }
      filename += `-${i}`;
    }
    filename += extname;
    await writeFile(nodePath.join(dir, filename));
    return nodePath.relative(config.paths.home, nodePath.join(dir, filename));
  }

  /**
   * Prepare message content for sending, splitting if necessary due to table limits.
   * @param content - Original message content.
   * @param streaming - Whether the message is being streamed (skip splitting if true).
   * @returns First chunk content and remaining chunks to send as follow-ups.
   */
  private _prepareMessageContent(
    content: AssistantMessage["content"],
    streaming: boolean,
  ): {
    firstMessageContent: AssistantMessage["content"];
    remainingChunks: string[];
  } {
    const lastTextContent = content.findLast((c) => c.type === "text");
    const markdownChunks = lastTextContent
      ? splitMarkdownByTables(lastTextContent.text)
      : [];
    const needsSplit = !streaming && markdownChunks.length > 1;

    const firstMessageContent = needsSplit
      ? (content.map((c) =>
          c.type === "text" ? { ...c, text: markdownChunks[0] } : c,
        ) as AssistantMessage["content"])
      : content;

    const remainingChunks = needsSplit ? markdownChunks.slice(1) : [];

    return { firstMessageContent, remainingChunks };
  }

  /**
   * Send remaining markdown chunks as follow-up reply messages.
   * @param messageId - The message ID to reply to.
   * @param chunks - Array of markdown strings to send.
   */
  private async _sendRemainingChunks(
    messageId: string,
    chunks: string[],
  ): Promise<void> {
    for (const chunkText of chunks) {
      const chunkCard = await renderMessageCard(
        [{ type: "text", text: chunkText }],
        {
          streaming: false,
          uploadImage: this.uploadImage.bind(this),
        },
      );
      await this._client.im.message.reply({
        path: {
          message_id: messageId,
        },
        data: {
          msg_type: "interactive",
          content: JSON.stringify(chunkCard),
          reply_in_thread: false,
        },
      });
    }
  }

  /** Extract local file paths from markdown link syntax [text](path) in text. */
  private _extractLocalFilePaths(text: string): string[] {
    const linkRegex = /(?<!!)\[.*?\]\(([^)]+)\)/g;
    const paths: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(text)) !== null) {
      const filePath = match[1];
      if (
        filePath &&
        !filePath.includes("://") &&
        fs.existsSync(nodePath.join(config.paths.home, filePath))
      ) {
        paths.push(filePath);
      }
    }
    return paths;
  }

  /** Upload local files referenced in text and send them as Feishu file message replies. */
  private async _sendLocalFileAttachments(
    messageId: string,
    text: string,
  ): Promise<void> {
    const filePaths = this._extractLocalFilePaths(text);
    const seen = new Set<string>();
    for (const filePath of filePaths) {
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      try {
        const fileKey = await this.uploadFile(filePath);
        await this._client.im.message.reply({
          path: { message_id: messageId },
          data: {
            msg_type: "file",
            content: JSON.stringify({ file_key: fileKey }),
            reply_in_thread: false,
          },
        });
        this._logger.info(`Sent file ${filePath} as Feishu attachment`);
      } catch (err) {
        this._logger.warn(
          { err },
          `Failed to send file attachment: ${filePath}`,
        );
      }
    }
  }

  private async _replyUpdateFailureMessage(messageId: string): Promise<void> {
    try {
      await this._client.im.message.reply({
        path: {
          message_id: messageId,
        },
        data: {
          msg_type: "text",
          content: JSON.stringify({
            text: "抱歉，这条消息更新失败了，请稍后重试。",
          }),
          reply_in_thread: false,
        },
      });
    } catch (err) {
      this._logger.warn(
        { err, message_id: messageId },
        "Failed to send fallback reply after Feishu card update error",
      );
    }
  }

  private _logOutboundMessage(
    sessionId: string,
    content: AssistantMessage["content"],
  ) {
    const lastText = content.filter((item) => item.type === "text").pop();
    const finalText = lastText?.type === "text" ? lastText.text : null;
    this._logger.info([sessionId, finalText], "Final Feishu outbound content");
  }

  private _handleCardAction = async (event: {
    action?: { value?: Record<string, string>; tag?: string };
    open_message_id?: string;
    open_id?: string;
    user_id?: string;
    message_id?: string;
    chat_id?: string;
  }) => {
    const value = event.action?.value;
    if (!value?.action || !value.session_id) return;

    const payload: CardActionPayload = {
      action: value.action,
      sessionId: value.session_id,
      messageId: event.open_message_id ?? event.message_id ?? "",
      chatId: event.chat_id ?? "",
      userId: event.open_id ?? event.user_id,
    };

    this._logger.info(
      { action: payload.action, session_id: payload.sessionId },
      "Card action triggered",
    );
    this.emit("card:action", payload);
  };

  private _handleMessageReceive = async ({
    message: receivedMessage,
  }: MessageReceiveEventData) => {
    const { message_id: messageId, thread_id: threadId, chat_id: chatId, chat_type: chatType, parent_id: parentId } = receivedMessage;
    this._lastChatId = chatId;
    const session_id = this._resolveSessionId(threadId, chatId);

    const parsedContent = await this._parseMessageContent(
      messageId,
      receivedMessage.message_type,
      receivedMessage.content,
    );

    // When user quotes/replies to a previous message, fetch the original content via API
    // so the bot can "see" what was quoted (cards don't serialize to text in post format)
    this._logger.info(
      { parentId, messageId, chatType, msgType: receivedMessage.message_type },
      "Received message with parent context",
    );

    // Strategy: if parent_id is set (reply scenario), fetch the original message via API;
    // also try to extract quote from post content as fallback (for text quotes)
    let finalContent = parsedContent;
    let quotedText: string | null = null;

    if (parentId) {
      quotedText = await this._fetchQuotedText(parentId);
    } else if (receivedMessage.message_type === "post") {
      // For quote (引用) scenario without parent_id, try to extract quote from post content
      quotedText = await this._extractQuoteFromPost(receivedMessage.content);
    }

    if (quotedText) {
      const blockquote = quotedText
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
      finalContent = {
        type: "text",
        text: `${blockquote}\n\n---\n\n${parsedContent.text}`,
      };
      this._logger.info("Quoted text prepended to message content");
    } else {
      this._logger.warn(
        { parentId, msgType: receivedMessage.message_type },
        "No quoted text could be fetched",
      );
    }

    const userMessage: UserMessage = {
      id: messageId,
      session_id,
      role: "user",
      source: `${chatType}_${chatId}`,
      content: [finalContent],
    };
    this.emit("message:inbound", userMessage);
  };

  private _handleMessageRecall = async (data: {
    message_id?: string;
    chat_id?: string;
    recall_time?: string;
    recall_type?: string;
  }) => {
    if (!data.message_id) return;
    this._logger.info({ message_id: data.message_id }, "message recalled");
    this.emit("message:recalled", data.message_id, this.id);
  };

  private _threadIdToSessionId = new Map<string, string>();
  private _chatIdToSessionId = new Map<string, string>();

  /** Persist a thread→session mapping to DB and update the in-memory cache. */
  private _mapThreadToSession(threadId: string, sessionId: string) {
    this._threadIdToSessionId.set(threadId, sessionId);
    this._db
      .insert(feishuThreads)
      .values({
        thread_id: threadId,
        session_id: sessionId,
        created_at: Date.now(),
      })
      .onConflictDoNothing()
      .run();
  }

  /** Resolve a session ID, preferring thread/chat mapping, falling back to a new one. */
  private _resolveSessionId(threadId: string | undefined, chatId?: string): string {
    if (threadId) {
      if (this._threadIdToSessionId.has(threadId)) {
        return this._threadIdToSessionId.get(threadId)!;
      }
      const row = this._db
        .select({ session_id: feishuThreads.session_id })
        .from(feishuThreads)
        .where(eq(feishuThreads.thread_id, threadId))
        .get();
      if (row) {
        this._threadIdToSessionId.set(threadId, row.session_id);
        return row.session_id;
      }
    }
    // For p2p and group chats, use chat_id to maintain session continuity
    if (chatId) {
      if (this._chatIdToSessionId.has(chatId)) {
        return this._chatIdToSessionId.get(chatId)!;
      }
      const sessionId = uuid();
      this._chatIdToSessionId.set(chatId, sessionId);
      return sessionId;
    }
    return uuid();
  }

  private async _parseMessageContent(
    messageId: string,
    type: string,
    content: string,
  ): Promise<TextMessageContent> {
    const json = JSON.parse(content);
    if (type === "text") {
      return {
        type: "text",
        text: json.text,
      };
    } else if (type === "post") {
      const markdown = await convertPostToMarkdown(
        json,
        this.downloadMessageResource.bind(this, messageId),
      );
      return {
        type: "text",
        text: markdown,
      };
    } else if (type === "image") {
      const file_key = json.image_key as string;
      const path = await this.downloadMessageResource(messageId, file_key);
      return {
        type: "text",
        text: `![user_uploaded_image](${path})`,
      };
    } else if (type === "file") {
      const file_key = json.file_key as string;
      const file_name = json.file_name as string;
      const path = await this.downloadMessageResource(
        messageId,
        file_key,
        file_name,
      );
      return {
        type: "text",
        text: `A new file message uploaded to \`${path}\``,
      };
    } else {
      this._logger.error(`Unsupported message type: ${type}`);
      return { type: "text", text: "Unsupported message type" + type };
    }
  }

  /**
   * Fetch a message by ID via Feishu API and extract its text content.
   * Used when a user quotes a previous message, so the bot can "see"
   * what was quoted (especially for cards whose content is lost in post format).
   */
  private async _fetchQuotedText(messageId: string): Promise<string | null> {
    try {
      const result = await this._client.im.message.get({
        path: { message_id: messageId },
      });

      // Check API-level error code (200 HTTP but error in body)
      if (result?.code && result.code !== 0) {
        this._logger.warn(
          { code: result.code, msg: result.msg, messageId },
          "Feishu API returned error when fetching quoted message",
        );
        return null;
      }

      const item = result?.data?.items?.[0];
      if (!item) {
        this._logger.warn({ messageId }, "No message item found for quoted message");
        return null;
      }

      if (!item.msg_type) {
        this._logger.warn({ messageId, item }, "Quoted message has no msg_type");
        return null;
      }

      // Try body.content first (SDK typed field), fall back to raw content
      const itemContent = (item.body?.content ?? (item as Record<string, unknown>).content) as string | undefined;
      if (!itemContent) {
        this._logger.warn(
          { messageId, msgType: item.msg_type, hasBody: !!item.body, itemKeys: Object.keys(item) },
          "Quoted message has no content in either body.content or content",
        );
        return null;
      }

      return await this._extractTextFromMsg(item.msg_type, itemContent);
    } catch (err) {
      this._logger.warn({ err, messageId }, "Failed to fetch quoted message");
      return null;
    }
  }

  /**
   * Try to extract quoted text from a post-type message content.
   * Used when parent_id is not set (quote scenario via 引用).
   * Feishu renders the quoted content as the first paragraph(s) of the post.
   */
  private async _extractQuoteFromPost(content: string): Promise<string | null> {
    try {
      const parsed = JSON.parse(content);
      const postContent = parsed?.content as unknown[] | undefined;
      if (!Array.isArray(postContent) || postContent.length < 2) return null;

      // Log the first few paragraphs to understand quote structure
      const firstPara = Array.isArray(postContent[0]) ? (postContent[0] as unknown[]) : [];
      const unknownTags = new Set<string>();
      const knownTags = new Set(["text", "a", "at", "img", "media", "emotion", "code_block", "hr", "md"]);
      let firstParaText = "";

      for (const el of firstPara) {
        const elem = el as Record<string, unknown>;
        if (elem?.tag && typeof elem.tag === "string" && !knownTags.has(elem.tag)) {
          unknownTags.add(elem.tag);
        }
        if (elem?.text && typeof elem.text === "string") {
          firstParaText += elem.text;
        }
      }

      if (unknownTags.size > 0) {
        this._logger.info(
          { unknownTags: [...unknownTags], firstParaText },
          "Unknown post element tags found - possible quote structure",
        );
      }

      // If first paragraph has text (even just sender name), include it
      return firstParaText.trim() || null;
    } catch (err) {
      this._logger.warn({ err }, "Failed to extract quote from post content");
      return null;
    }
  }

  /**
   * Extract readable text from a Feishu message body content string,
   * handling text, interactive (card), and post formats.
   */
  private async _extractTextFromMsg(msgType: string, content: string): Promise<string | null> {
    try {
      const parsed = JSON.parse(content);
      if (msgType === "text") {
        return typeof parsed.text === "string" ? parsed.text.trim() : null;
      }

      if (msgType === "interactive") {
        // Card format — may be single object or array
        const card = Array.isArray(parsed) ? parsed[0] : parsed;
        const parts: string[] = [];

        // Header title
        const head = card.head ?? card.header;
        if (head?.title?.content) {
          parts.push(head.title.content);
        }

        // Body elements
        const elements = card.body?.elements ?? card.elements ?? [];
        for (const el of elements) {
          // Try direct text.content, then el.content, then other common text fields
          const text =
            el?.text?.content ??
            el?.content ??
            (typeof el?.text === "string" ? el.text : null);
          if (typeof text === "string") {
            parts.push(text);
          }
        }

        const result = parts.join("\n").trim();
        if (!result) {
          this._logger.warn(
            { msgType, cardKeys: Object.keys(card), hasHeader: !!head, elementCount: elements.length },
            "Interactive card text extraction yielded empty result",
          );
        }
        return result || null;
      }

      if (msgType === "post") {
        // Post format — convert to markdown using existing logic
        try {
          return await convertPostToMarkdown(
            parsed,
            async () => "", // skip resource download for quoted content
          );
        } catch {
          return null;
        }
      }

      return null;
    } catch {
      return null;
    }
  }
}
