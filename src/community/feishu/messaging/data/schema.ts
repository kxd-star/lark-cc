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


/**
 * Caches the plain-text content of bot reply messages (especially cards).
 *
 * Feishu API does not return actual content for interactive/card messages
 * via GET /im/v1/messages/{id} - it returns a placeholder string instead.
 * This table stores the text at send time so quoted replies can retrieve
 * the original content without depending on the API read path.
 *
 * Rows are best-effort and inserted with ON CONFLICT DO NOTHING since
 * the text is determined at send time and does not change.
 */
export const feishuMessageTextCache = sqliteTable("feishu_message_text_cache", {
  /** The Feishu message ID (typically a bot's reply message). */
  message_id: text("message_id").primaryKey(),
  /** Plain text content extracted from the message at send time. */
  text_content: text("text_content").notNull(),
  /** Epoch milliseconds when the cache entry was created. */
  created_at: integer("created_at").notNull(),
});
