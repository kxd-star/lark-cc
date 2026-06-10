import { join } from "node:path";

import dayjs from "dayjs";

import { config, type UserMessage } from "@/shared";
import type { Message } from "@/shared";

import { appendFile, ensureFile, formatFileLine } from "./session-writer-utils";

interface QueuedItem {
  message: Message;
  path: string;
}

/**
 * Appends messages to daily log file, partitioned by source (e.g. "p2p", "group").
 * Messages with no source go to the default `logs/` directory.
 * Uses internal queue for sequential writes.
 */
export class SessionDailyLogWriter {
  private readonly _source?: string;

  constructor(source?: string) {
    this._source = source;
  }

  write(message: Message): void {
    const source = message.role === "user"
      ? ((message as UserMessage).source ?? this._source)
      : this._source;
    const dir = source ? `logs/${source}` : "logs";
    const dateString = dayjs(new Date()).format("YYYY-MM-DD");
    const path = join(config.paths.memory, dir, `${dateString}.md`);
    this._queue.push({ message, path });
    this._drain();
  }

  private _queue: QueuedItem[] = [];
  private _processing = false;

  private _drain(): void {
    if (this._processing || this._queue.length === 0) {
      return;
    }
    this._processing = true;
    const item = this._queue.shift()!;
    const line = formatFileLine(item.message);
    if (line) {
      ensureFile(item.path);
      const content = `${line}\n\n`;
      appendFile(item.path, content, () => {
        this._processing = false;
        if (this._queue.length > 0) {
          setImmediate(() => this._drain());
        }
      });
    } else {
      this._processing = false;
      if (this._queue.length > 0) {
        setImmediate(() => this._drain());
      }
    }
  }
}
