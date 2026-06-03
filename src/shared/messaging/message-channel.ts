import type EventEmitter from "eventemitter3";

import type { AssistantMessage, UserMessage } from "./types";

export interface CardActionPayload {
  action: string;
  sessionId: string;
  messageId: string;
  chatId: string;
  userId?: string;
}

/** Event types emitted by a message channel. */
export interface MessageChannelEventTypes {
  // eslint-disable-next-line no-unused-vars
  "message:inbound": (message: UserMessage) => void;
  // eslint-disable-next-line no-unused-vars
  "message:recalled": (messageId: string, channelId: string) => void;
  // eslint-disable-next-line no-unused-vars
  "card:action": (payload: CardActionPayload) => void;
}

/** Abstract message channel for sending and receiving messages. */
export interface MessageChannel extends EventEmitter {
  /** Channel ID. */
  readonly id: string;

  /** Channel type identifier (e.g. "feishu"). */
  readonly type: string;

  /** Start the channel and begin listening for inbound messages. */
  start(): Promise<void>;

  /**
   * Post a new assistant message without replying to an existing message.
   * @param message - The assistant message to post (without id).
   * @returns The posted message with id assigned.
   */
  // eslint-disable-next-line no-unused-vars
  postMessage(message: Omit<AssistantMessage, "id">): Promise<AssistantMessage>;

  /**
   * Reply to an existing message.
   * @param messageId - ID of the message to reply to.
   * @param message - The assistant message to send (without id).
   * @param options - Optional settings (e.g. streaming mode).
   * @returns The sent message with id assigned.
   */
  replyMessage(
    // eslint-disable-next-line no-unused-vars
    messageId: string,
    // eslint-disable-next-line no-unused-vars
    message: Omit<AssistantMessage, "id">,
    // eslint-disable-next-line no-unused-vars
    options?: { streaming?: boolean },
  ): Promise<AssistantMessage>;

  /**
   * Update the content of an existing message.
   * @param message - The assistant message with updated content.
   * @param options - Optional settings (e.g. streaming mode).
   */
  updateMessageContent(
    // eslint-disable-next-line no-unused-vars
    message: AssistantMessage,
    // eslint-disable-next-line no-unused-vars
    options?: { streaming?: boolean },
  ): Promise<void>;
}
