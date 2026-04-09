/**
 * Structured debug logger for the main process.
 *
 * Writes JSON-lines to ~/.ARchitect/logs/debug.jsonl with automatic
 * rotation. Taps into existing ACP event streams — no new event
 * producers needed.
 *
 * Main-process only. The renderer captures its state via on-demand
 * snapshots through the debug:export IPC channel.
 */
import * as fs from "fs";
import * as path from "path";

export interface DebugLogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  category: string;
  data: Record<string, unknown>;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_ROTATED_FILES = 2;

export class DebugLogger {
  private stream: fs.WriteStream | null = null;
  private bytesWritten = 0;
  private readonly logFile: string;

  /** Buffer for agent_message_chunk events — flushed as a single merged entry. */
  private messageBuffer = "";

  constructor(
    private readonly logDir: string,
    private readonly maxBytes: number = DEFAULT_MAX_BYTES,
  ) {
    // nosemgrep: path-join-resolve-traversal — logDir is set from a trusted source (architectDir) in main.ts
    this.logFile = path.join(logDir, "debug.jsonl");

    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Resume byte count from existing file
    if (fs.existsSync(this.logFile)) {
      try {
        this.bytesWritten = fs.statSync(this.logFile).size;
      } catch {
        this.bytesWritten = 0;
      }
    }

    this.stream = this.openStream();
  }

  /** Open a write stream with an error handler to prevent uncaught exceptions. */
  private openStream(): fs.WriteStream {
    const stream = fs.createWriteStream(this.logFile, { flags: "a" });
    stream.on("error", (err) => {
      console.error("[DebugLogger] Write error:", err.message);
      this.stream = null;
    });
    return stream;
  }

  /**
   * Log an ACP session-update event with automatic chunk merging.
   *
   * agent_message_chunk events are buffered and flushed as a single
   * `session-agent_message` entry when a non-chunk event arrives.
   * This keeps the log readable — one entry per full message instead
   * of hundreds of tiny fragments.
   */
  logSessionEvent(update: Record<string, unknown>): void {
    const eventType = update.sessionUpdate as string | undefined;

    if (eventType === "agent_message_chunk") {
      const chunkText = (update.content as { text?: string })?.text ?? "";
      this.messageBuffer += chunkText;
      return;
    }

    // Non-chunk event — flush any buffered message text first
    this.flushMessageBuffer();
    const category = `session-${eventType ?? "unknown"}`;
    this.logEvent(category, update);
  }

  /**
   * Flush the accumulated message buffer as a single log entry.
   * Called automatically by logSessionEvent on non-chunk events,
   * and explicitly on process exit / close.
   */
  flushMessageBuffer(): void {
    if (this.messageBuffer.length === 0) return;
    this.logEvent("session-agent_message", {
      sessionUpdate: "agent_message",
      text: this.messageBuffer,
      length: this.messageBuffer.length,
    });
    this.messageBuffer = "";
  }

  /** Append a structured log entry. */
  logEvent(
    category: string,
    data: Record<string, unknown>,
    level: DebugLogEntry["level"] = "info",
  ): void {
    if (!this.stream) return;

    const entry: DebugLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      category,
      data,
    };
    const line = JSON.stringify(entry) + "\n";
    this.stream.write(line);
    this.bytesWritten += Buffer.byteLength(line);

    if (this.bytesWritten > this.maxBytes) {
      this.rotate();
    }
  }

  /**
   * Read recent log entries for the debug export.
   * Reads from rotated + current log files, returns the last N entries.
   *
   * Uses synchronous reads — acceptable since this is user-initiated
   * and infrequent. Worst case ~30MB across 3 files (~30-50ms on SSD).
   */
  /**
     * Read recent log entries for the debug export.
     * Reads from rotated + current log files, returns the last N entries.
     *
     * Merges consecutive `session-agent_message_chunk` entries into single
     * `session-agent_message` entries so the export is clean regardless of
     * whether the chunks were written before or after the write-time buffering.
     *
     * Uses synchronous reads — acceptable since this is user-initiated
     * and infrequent. Worst case ~30MB across 3 files (~30-50ms on SSD).
     */
    readRecentEntries(maxEntries = 1000): DebugLogEntry[] {
      // Flush any in-progress message so the export includes it
      this.flushMessageBuffer();

      const rawEntries: DebugLogEntry[] = [];

      // Read rotated files first (oldest), then current
      for (let i = MAX_ROTATED_FILES; i >= 0; i--) {
        const file = i === 0 ? this.logFile : `${this.logFile}.${i}`;
        if (!fs.existsSync(file)) continue;

        try {
          const content = fs.readFileSync(file, "utf-8");
          const lines = content.split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              rawEntries.push(JSON.parse(line) as DebugLogEntry);
            } catch {
              // Skip malformed lines
            }
          }
        } catch {
          // Skip unreadable files
        }
      }

      // Merge consecutive chunk entries into single message entries
      const merged: DebugLogEntry[] = [];
      let chunkBuffer = "";
      let chunkTimestamp = "";

      for (const entry of rawEntries) {
        if (entry.category === "session-agent_message_chunk") {
          const text = (entry.data.content as { text?: string })?.text
            ?? (entry.data.text as string)
            ?? "";
          if (!chunkTimestamp) chunkTimestamp = entry.timestamp;
          chunkBuffer += text;
          continue;
        }

        // Non-chunk entry — flush any accumulated chunks first
        if (chunkBuffer.length > 0) {
          merged.push({
            timestamp: chunkTimestamp,
            level: "info",
            category: "session-agent_message",
            data: { sessionUpdate: "agent_message", text: chunkBuffer, length: chunkBuffer.length },
          });
          chunkBuffer = "";
          chunkTimestamp = "";
        }
        merged.push(entry);
      }

      // Flush trailing chunks
      if (chunkBuffer.length > 0) {
        merged.push({
          timestamp: chunkTimestamp,
          level: "info",
          category: "session-agent_message",
          data: { sessionUpdate: "agent_message", text: chunkBuffer, length: chunkBuffer.length },
        });
      }

      return merged.slice(-maxEntries);
    }

  /** Rotate the current log file. */
  private rotate(): void {
    this.stream?.end();
    this.stream = null;

    // Delete the oldest rotated file
    const oldest = `${this.logFile}.${MAX_ROTATED_FILES}`;
    if (fs.existsSync(oldest)) {
      try { fs.unlinkSync(oldest); } catch { /* best effort */ }
    }

    // Shift remaining: .1 → .2, current → .1
    for (let i = MAX_ROTATED_FILES - 1; i >= 0; i--) {
      const src = i === 0 ? this.logFile : `${this.logFile}.${i}`;
      const dest = `${this.logFile}.${i + 1}`;
      if (fs.existsSync(src)) {
        try { fs.renameSync(src, dest); } catch { /* best effort */ }
      }
    }

    this.bytesWritten = 0;
    this.stream = this.openStream();
  }

  /** Flush any buffered message, then close the log stream. */
  close(): void {
    this.flushMessageBuffer();
    this.stream?.end();
    this.stream = null;
  }
}
