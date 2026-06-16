#!/usr/bin/env node
/**
 * Archive old session files with summary preservation.
 *
 * Steps:
 *   1. Find sessions not modified in DAYS_OLD days
 *   2. For each: extract topic + conclusion -> append to memory/context.md
 *   3. Gzip-archive to ~/session_archive/<bot>/
 *   4. Trim context.md if it exceeds MAX_CONTEXT_LINES
 *
 * This ensures new sessions can reference past conversations via context.md.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync, unlinkSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream } from "node:fs";

const DAYS_OLD = 7;
const MAX_SIZE_KB = 800;
const MIN_AGE_MINUTES = 30; // skip files modified in last 30 min (likely active)
const MAX_CONTEXT_LINES = 200;
const ARCHIVE_BASE = "/home/ubuntu/session_archive";

const BOTS = [
  { home: "/home/ubuntu/.agentara",        contextFile: "/home/ubuntu/.agentara/memory/context.md" },
  { home: "/home/ubuntu/.agentara-codex",  contextFile: "/home/ubuntu/.agentara-codex/memory/context.md" },
];

function ageMinutes(path) {
  return (Date.now() - statSync(path).mtimeMs) / 60_000;
}

function daysSince(path) {
  return (Date.now() - statSync(path).mtimeMs) / 86_400_000;
}

function sizeKB(path) {
  return statSync(path).size / 1024;
}

/** Read the first user text and last substantial assistant text from a JSONL session file. */
function extractSummary(filePath) {
  const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  let firstUserText = "";
  let lastAssistantText = "";
  let userCount = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const role = entry.role;
      const content = entry.content ?? [];

      for (const block of content) {
        if (block.type !== "text" || !block.text) continue;
        const text = block.text.trim();
        if (!text) continue;
        if (text.startsWith("[引用消息]")) continue;

        if (role === "user" && !firstUserText) {
          firstUserText = text.slice(0, 200);
        }
        if (role === "assistant" && text.length > 10) {
          lastAssistantText = text.slice(0, 500);
        }
      }

      if (role === "user") userCount++;
    } catch {
      // Skip malformed lines
    }
  }

  return { firstUserText, lastAssistantText, messageCount: userCount };
}

/** Append a structured summary entry to context.md. */
function appendSummary(contextFile, sessionId, summary) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(11, 16);

  const parts = [];
  parts.push("");
  parts.push("---");
  parts.push("[" + dateStr + " " + timeStr + "] Session " + sessionId);
  parts.push("消息数: " + summary.messageCount);
  if (summary.firstUserText) parts.push("主题: " + summary.firstUserText);
  if (summary.lastAssistantText) parts.push("结论: " + summary.lastAssistantText);

  const entry = parts.join("\n") + "\n";

  const dir = dirname(contextFile);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(contextFile, entry, { flag: "a" });
}

/** Trim context.md to at most MAX_CONTEXT_LINES lines, keeping the most recent entries. */
function trimContext(contextFile) {
  if (!existsSync(contextFile)) return;
  const content = readFileSync(contextFile, "utf-8");
  const lines = content.split("\n");
  if (lines.length <= MAX_CONTEXT_LINES) return;

  const trimmed = lines.slice(lines.length - MAX_CONTEXT_LINES);
  writeFileSync(contextFile, trimmed.join("\n") + "\n");
  console.log("  Trimmed to " + MAX_CONTEXT_LINES + " lines");
}

/** Gzip a file to the archive directory, then remove the original. */
async function archiveFile(srcPath, archiveDir) {
  const name = basename(srcPath);
  const destPath = join(archiveDir, name + ".gz");

  await pipeline(
    createReadStream(srcPath),
    createGzip(),
    createWriteStream(destPath),
  );

  unlinkSync(srcPath);
}

async function main() {
  for (const bot of BOTS) {
    const sessionDir = join(bot.home, "sessions");
    if (!existsSync(sessionDir)) continue;

    const botName = basename(bot.home);
    const archiveDir = join(ARCHIVE_BASE, botName);
    mkdirSync(archiveDir, { recursive: true });

    const files = readdirSync(sessionDir).filter(f => f.endsWith(".jsonl"));

    for (const file of files) {
      const filePath = join(sessionDir, file);

      // Skip the currently-active session (recently modified)
      if (ageMinutes(filePath) < MIN_AGE_MINUTES) continue;

      const shouldArchive =
        daysSince(filePath) >= DAYS_OLD ||    // inactive for a while
        sizeKB(filePath) >= MAX_SIZE_KB;       // too large, prevent overflow

      if (!shouldArchive) continue;

      const archivePath = join(archiveDir, file + ".gz");
      if (existsSync(archivePath)) {
        continue;
      }

      const sessionId = file.replace(/\.jsonl$/, "");

      // Extract and append summary
      const summary = extractSummary(filePath);
      if (summary.firstUserText || summary.lastAssistantText) {
        appendSummary(bot.contextFile, sessionId, summary);
        console.log("  Summary appended to " + botName + "/context.md");
      } else {
        console.log("  Empty session, no summary");
      }

      // Archive (skip empty files)
      const fsStat = statSync(filePath);
      if (fsStat.size > 0) {
        await archiveFile(filePath, archiveDir);
        console.log("  Archived: " + botName + "/" + file + " (" + (fsStat.size / 1024).toFixed(1) + " KB)");
      }
    }

    trimContext(bot.contextFile);
  }

  console.log("Done.");
}

main().catch(err => {
  console.error("Archive script failed:", err);
  process.exit(1);
});
