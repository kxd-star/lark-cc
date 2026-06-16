import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Maps Feishu thread IDs to Agentara session IDs.
 *
 * Each row represents a single Feishu message thread that has been
 * associated with a session. The in-memory cache in
 * {@link FeishuMessageChannel} is the hot path; this table is the
 * durable fallback that survives restarts.
 */
export const feishuThreads = sqliteTable("feishu_threads", {
  /** The Feishu thread identifier (unique per conversation thread). */
  thread_id: text("thread_id").primaryKey(),
  /** The Agentara session identifier. */
  session_id: text("session_id").notNull(),
  /** Epoch milliseconds when the mapping was created. */
  created_at: integer("created_at").notNull(),
});

/**
 * Maps parent message IDs (user message) to bot reply message IDs.
 *
 * When a user quotes/replies to a bot's card, Feishu's parent_id may point
 * to the original user message (thread root) rather than the bot's card.
 * This table stores the actual bot reply ID so we can fetch the card content.
 */
export const feishuParentReplies = sqliteTable("feishu_parent_replies", {
  /** The parent message ID (user's original message). */
  parent_id: text("parent_id").primaryKey(),
  /** The bot's reply message ID (the actual card/response). */
  bot_reply_id: text("bot_reply_id").notNull(),
  /** Epoch milliseconds when the mapping was created. */
  created_at: integer("created_at").notNull(),
});
