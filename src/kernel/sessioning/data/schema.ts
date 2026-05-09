import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Persisted session records that track session metadata across restarts.
 *
 * Message content is still stored in `.jsonl` files — this table only
 * holds the session envelope (who, where, when).
 */
export const sessions = sqliteTable("sessions", {
  /** Unique session identifier. */
  id: text("id").primaryKey(),
  /** The agent runner type, e.g. `"claude-code"`. */
  agent_type: text("agent_type").notNull(),
  /** Working directory the session was created with. */
  cwd: text("cwd").notNull(),
  /** The channel id this session belongs to, or null for legacy sessions. */
  channel_id: text("channel_id"),
  /** The text content of the session's first inbound message. */
  first_message: text("first_message").notNull().default(""),
  /** Runner-specific session/thread id (e.g. Codex thread id) for resume. */
  runner_session_id: text("runner_session_id"),
  /** Whether this session was created via handoff from an external Claude Code instance. */
  handoff: integer("handoff").default(0),
  /** Epoch milliseconds of the most recent message, or null if no messages yet. */
  last_message_created_at: integer("last_message_created_at"),
  /** Epoch milliseconds when the session was created. */
  created_at: integer("created_at").notNull(),
  /** Epoch milliseconds when the session was last updated. */
  updated_at: integer("updated_at").notNull(),
});
