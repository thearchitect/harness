// The transcripts of the session's `claude` subagents: every line Claude writes and every message
// harness sends it, as they come, into ~/.harness/hub/claude/<session>.jsonl (Claude's documented
// stream-json, not its internal files) and into the session's live ClaudeTranscript, whose changed
// entries go to the clients. A transcript not live (a client opened it after a restart) is read
// back from its log.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeTranscript, type ClaudeInputLine, type TranscriptEntry, type TranscriptMessage } from "#protocol/claude-transcript.ts";

export type TranscriptPublisher = (session: string, entries: TranscriptEntry[], streaming: TranscriptMessage | null) => void;

export class ClaudeTranscripts {
  private readonly dir: string;
  private readonly publish: TranscriptPublisher;
  private readonly live = new Map<string, ClaudeTranscript>();

  /** `dir`: where the transcripts are kept (~/.harness/hub/claude). */
  constructor(dir: string, publish: TranscriptPublisher) {
    this.dir = dir;
    this.publish = publish;
  }

  private log(session: string): string {
    return join(this.dir, `${session.replace(/[^\w-]/g, "_")}.jsonl`);
  }

  /** A session's transcript: the live one, or read back from its log (empty without one). */
  get(session: string): ClaudeTranscript {
    const known = this.live.get(session);
    if (known !== undefined) {
      return known;
    } else {
      const transcript = new ClaudeTranscript();
      const path = this.log(session);
      if (existsSync(path)) {
        for (const line of readFileSync(path, "utf8").split("\n")) {
          try {
            transcript.push(JSON.parse(line) as { type: string });
          } catch {
            // a torn last line: the rest stands
          }
        }
      } else {
        // a subagent that never wrote
      }
      this.live.set(session, transcript);
      return transcript;
    }
  }

  /** One line of a session (Claude's, or what harness sent it): kept, and its changes published. */
  record(session: string, line: { type: string } | ClaudeInputLine, raw?: string): void {
    // what the log has so far first (a continued subagent's earlier runs), then this line
    const transcript = this.get(session);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    appendFileSync(this.log(session), `${raw ?? JSON.stringify(line)}\n`, { mode: 0o600 });
    const streamingBefore = transcript.streaming;
    const changed = transcript.push(line);
    const entries = changed.map((id) => transcript.entry(id)).filter((entry): entry is TranscriptEntry => entry !== undefined);
    if (entries.length > 0 || transcript.streaming !== streamingBefore) {
      this.publish(session, entries, transcript.streaming ?? null);
    } else {
      // nothing a client draws changed
    }
  }
}
