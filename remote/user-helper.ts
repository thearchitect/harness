/**
 * Work on one user's pi data, run by the gateway as that user (their tokens in
 * their own ~/.pi/agent/auth.json, their sessions in ~/.pi/agent/sessions) and
 * driven over stdio with JSONL:
 *
 *   node user-helper.ts providers
 *                       login <provider> | logout <provider>
 *                       sessions
 *                       history <cwd> <sessionId> <turns>
 *                       models                      (run under cage: API keys)
 *                       models-save <json>          {favorites:[{provider,id,effort}],default}
 *                       transcribe <file>           OpenAI speech to text, streamed
 *
 * helper → gateway: {"type":"providers","list":[{id,name,loggedIn}]}
 *                   {"type":"sessions","list":[{id,cwd,title,modified}]}
 *                   {"type":"history","title":"…","turns":[{prompt,answer}]}
 *                   {"type":"models","models":ModelSettings}
 *                   {"type":"delta","text":"…"} … {"type":"transcript","text":"…"}
 *                   {"type":"prompt","id":"1","prompt":AuthPrompt}
 *                   {"type":"notify","event":AuthEvent}
 *                   {"type":"done","ok":true} | {"type":"done","ok":false,"error":"…"}
 * gateway → helper: {"type":"answer","id":"1","value":"…"}
 *
 * The gateway ends a run (a cancelled login, a deadline) by killing the helper.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
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

/** The model whose thinking levels a favorite may use: its supported levels, "off" first. */
function levelsOf(model: Model<Api>): string[] {
  return getSupportedThinkingLevels(model);
}

type Favorite = { provider: string; id: string; effort?: string };

async function models(agentDir: string): Promise<object> {
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), refreshOnCreate: false });
  const settings = SettingsManager.create(homedir(), agentDir);
  const available = (await runtime.getAvailable()).map((m) => ({ provider: m.provider, id: m.id, name: m.name, levels: levelsOf(m) }));
  const enabled = settings.getEnabledModels() ?? [];
  const exact = enabled.filter((entry) => /^[^*?[\]]+\/[^*?[\]]+$/.test(entry));
  const levels = settings.getAllModelThinkingLevels();
  return {
    available,
    favorites: exact.map((entry): Favorite => {
      const slash = entry.indexOf("/");
      const provider = entry.slice(0, slash);
      const id = entry.slice(slash + 1);
      return { provider, id, ...(levels[entry] !== undefined ? { effort: levels[entry] } : {}) };
    }),
    patterns: enabled.filter((entry) => !exact.includes(entry)),
    default: settings.getDefaultProvider() !== undefined && settings.getDefaultModel() !== undefined ? { provider: settings.getDefaultProvider(), id: settings.getDefaultModel() } : null,
  };
}

async function saveModels(agentDir: string, json: string): Promise<void> {
  const wanted = JSON.parse(json) as { favorites: Favorite[]; default: { provider: string; id: string } | null };
  const settings = SettingsManager.create(homedir(), agentDir);
  const before = settings.getEnabledModels() ?? [];
  const patterns = before.filter((entry) => !/^[^*?[\]]+\/[^*?[\]]+$/.test(entry));
  const keys = wanted.favorites.map((f) => `${f.provider}/${f.id}`);
  for (const entry of before) {
    const slash = entry.indexOf("/");
    if (slash > 0 && !keys.includes(entry)) settings.removeModelThinkingLevel(entry.slice(0, slash), entry.slice(slash + 1));
  }
  for (const favorite of wanted.favorites) {
    if (favorite.effort !== undefined) {
      settings.setModelThinkingLevel(favorite.provider, favorite.id, favorite.effort as never);
    } else {
      settings.removeModelThinkingLevel(favorite.provider, favorite.id);
    }
  }
  settings.setEnabledModels(keys.length > 0 || patterns.length > 0 ? [...keys, ...patterns] : undefined);
  if (wanted.default !== null) settings.setDefaultModelAndProvider(wanted.default.provider, wanted.default.id);
  await settings.flush();
}

/** OpenAI speech to text (gpt-4o-transcribe), streamed, with the user's OpenAI login. */
async function transcribe(agentDir: string, file: string): Promise<void> {
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), refreshOnCreate: false });
  let token: string | undefined;
  for (const provider of ["openai-codex", "openai"]) {
    const auth = await runtime.getAuth(provider).catch(() => undefined);
    if (auth?.auth.apiKey !== undefined) {
      token = auth.auth.apiKey;
      break;
    }
  }
  if (token === undefined) throw new Error("no OpenAI login");
  const form = new FormData();
  form.set("model", process.env.HARNESS_TRANSCRIBE_MODEL ?? "gpt-4o-transcribe");
  form.set("stream", "true");
  form.set("file", new Blob([readFileSync(file)], { type: "audio/ogg" }), basename(file));
  const response = await fetch(process.env.HARNESS_TRANSCRIBE_URL ?? "https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!response.ok || response.body === null) {
    throw new Error(`transcription failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  let text = "";
  let pending = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk as Uint8Array, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "" || data === "[DONE]") continue;
      const event = JSON.parse(data) as { type?: string; delta?: string; text?: string };
      if (event.type === "transcript.text.delta" && event.delta !== undefined) {
        text += event.delta;
        send({ type: "delta", text: event.delta });
      } else if (event.type === "transcript.text.done" && event.text !== undefined) {
        text = event.text;
      } else {
        // other events carry nothing to show
      }
    }
  }
  send({ type: "transcript", text: text.trim() });
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
    case "models":
      send({ type: "models", models: await models(agentDir) });
      return;
    case "models-save": {
      const [json] = args;
      if (json === undefined) throw new Error("usage: models-save <json>");
      await saveModels(agentDir, json);
      return;
    }
    case "transcribe": {
      const [file] = args;
      if (file === undefined) throw new Error("usage: transcribe <file>");
      await transcribe(agentDir, file);
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
