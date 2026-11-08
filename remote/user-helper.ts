/**
 * Work on one user's pi data, run by the gateway as that user (their tokens in
 * their own ~/.pi/agent/auth.json, their sessions in ~/.pi/agent/sessions) and
 * driven over stdio with JSONL:
 *
 *   node user-helper.ts providers
 *                       login <provider> | logout <provider>
 *                       sessions
 *                       history <cwd> <sessionId> <turns>
 *
 * helper → gateway: {"type":"providers","list":[{id,name,loggedIn}]}
 *                   {"type":"sessions","list":[{id,cwd,title,modified}]}
 *                   {"type":"history","title":"…","turns":[{prompt,answer}]}
 *                   {"type":"prompt","id":"1","prompt":AuthPrompt}
 *                   {"type":"notify","event":AuthEvent}
 *                   {"type":"done","ok":true} | {"type":"done","ok":false,"error":"…"}
 * gateway → helper: {"type":"answer","id":"1","value":"…"}
 *
 * The gateway ends a run (a cancelled login, a deadline) by killing the helper.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

type Incoming = { type: "answer"; id: string; value: string };

/** How many sessions the gateway gets, most recently modified first. */
const SESSIONS_LIMIT = 200;
const TITLE_LENGTH = 80;

function send(record: object): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

const waiting = new Map<string, (value: string) => void>();
let nextId = 1;
let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  const lines = (buffer + chunk).split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines.filter((l) => l.trim() !== "")) {
    const message = JSON.parse(line) as Incoming;
    waiting.get(message.id)?.(message.value);
    waiting.delete(message.id);
  }
});

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line;
}

/** The text of a user or assistant message: its text parts, nothing else. */
function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  } else if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: "text"; text: string } => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text")
      .map((part) => part.text)
      .join("\n");
  } else {
    return "";
  }
}

/** The last `count` turns of a session: each user prompt and the last assistant text before the next prompt. */
function history(cwd: string, sessionId: string, count: number): { title: string; turns: { prompt: string; answer: string }[] } {
  const path = SessionManager.findById(cwd, sessionId);
  if (path === undefined) {
    return { title: "", turns: [] };
  } else {
    const session = SessionManager.open(path);
    const turns: { prompt: string; answer: string }[] = [];
    for (const entry of session.getBranch()) {
      if (entry.type !== "message") {
        continue; // model changes, custom entries, compactions: not part of a turn's text
      } else {
        const message = entry.message as { role?: string; content?: unknown };
        const text = textOf(message.content).trim();
        if (message.role === "user" && text !== "") {
          turns.push({ prompt: text, answer: "" });
        } else if (message.role === "assistant" && text !== "" && turns.length > 0) {
          (turns[turns.length - 1] as { answer: string }).answer = text;
        } else {
          // tool results, empty or tool-only assistant messages
        }
      }
    }
    const first = turns[0]?.prompt ?? "";
    return { title: oneLine(session.getSessionName() ?? first), turns: turns.slice(-count) };
  }
}

async function main(): Promise<void> {
  const [mode, ...args] = process.argv.slice(2);
  const agentDir = join(homedir(), ".pi", "agent");
  switch (mode) {
    case "sessions": {
      const sessions = await SessionManager.listAll();
      const list = sessions
        .sort((a, b) => b.modified.getTime() - a.modified.getTime())
        .slice(0, SESSIONS_LIMIT)
        .map((s) => ({ id: s.id, cwd: s.cwd, title: oneLine(s.name ?? s.firstMessage), modified: s.modified.getTime() }));
      send({ type: "sessions", list });
      return;
    }
    case "history": {
      const [cwd, sessionId, turns] = args;
      if (cwd === undefined || sessionId === undefined || turns === undefined) throw new Error("usage: history <cwd> <sessionId> <turns>");
      send({ type: "history", ...history(cwd, sessionId, Number(turns)) });
      return;
    }
    case "providers":
    case "login":
    case "logout": {
      const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), refreshOnCreate: false });
      const providerId = args[0];
      if (mode === "providers") {
        const credentials = await runtime.listCredentials();
        const list = runtime
          .getProviders()
          .filter((p) => p.auth.oauth !== undefined)
          .map((p) => ({ id: p.id, name: p.name, loggedIn: credentials.some((c) => c.providerId === p.id && c.type === "oauth") }));
        send({ type: "providers", list });
      } else if (providerId === undefined) {
        throw new Error(`usage: ${mode} <provider>`);
      } else if (mode === "login") {
        // The installation's stable id (OpenAI's ChatGPT sign-in needs it), kept in
        // the user's settings.json as pi itself does.
        const settings = SettingsManager.create(homedir(), agentDir);
        await runtime.login(providerId, "oauth", {
          prompt: (prompt) =>
            new Promise<string>((resolve) => {
              const id = String(nextId++);
              waiting.set(id, resolve);
              const { signal: _signal, ...shown } = prompt;
              send({ type: "prompt", id, prompt: shown });
            }),
          notify: (event) => send({ type: "notify", event }),
        }, { getDeviceId: () => settings.getOrCreateDeviceId() });
      } else {
        await runtime.logout(providerId);
      }
      return;
    }
    default:
      throw new Error("usage: user-helper.ts providers | login <provider> | logout <provider> | sessions | history <cwd> <sessionId> <turns>");
  }
}

main().then(
  () => {
    send({ type: "done", ok: true });
    process.exit(0);
  },
  (error: unknown) => {
    send({ type: "done", ok: false, error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  },
);
