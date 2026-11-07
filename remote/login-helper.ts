/**
 * OAuth login of one user, run by the gateway as that user (so the tokens land
 * in their own ~/.pi/agent/auth.json) and driven over stdio with JSONL:
 *
 *   node login-helper.ts list | login <provider> | logout <provider>
 *
 * helper → gateway: {"type":"providers","list":[{id,name,loggedIn}]}
 *                   {"type":"prompt","id":"1","prompt":AuthPrompt}
 *                   {"type":"notify","event":AuthEvent}
 *                   {"type":"done","ok":true} | {"type":"done","ok":false,"error":"…"}
 * gateway → helper: {"type":"answer","id":"1","value":"…"} | {"type":"cancel"}
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

type Incoming = { type: "answer"; id: string; value: string } | { type: "cancel" };

function send(record: object): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

const waiting = new Map<string, { resolve(value: string): void; reject(error: Error): void }>();
const cancel = new AbortController();
let nextId = 1;
let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  const lines = (buffer + chunk).split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines.filter((l) => l.trim() !== "")) {
    const message = JSON.parse(line) as Incoming;
    if (message.type === "answer") {
      waiting.get(message.id)?.resolve(message.value);
      waiting.delete(message.id);
    } else {
      cancel.abort();
      for (const waiter of waiting.values()) waiter.reject(new Error("cancelled"));
      waiting.clear();
    }
  }
});

async function main(): Promise<void> {
  const [mode, providerId] = process.argv.slice(2);
  const agentDir = join(homedir(), ".pi", "agent");
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), refreshOnCreate: false });
  // The installation's stable id (OpenAI's ChatGPT sign-in needs it), kept in
  // the user's settings.json as pi itself does.
  const settings = SettingsManager.create(homedir(), agentDir);
  if (mode === "list") {
    const credentials = await runtime.listCredentials();
    const list = runtime
      .getProviders()
      .filter((p) => p.auth.oauth !== undefined)
      .map((p) => ({ id: p.id, name: p.name, loggedIn: credentials.some((c) => c.providerId === p.id && c.type === "oauth") }));
    send({ type: "providers", list });
  } else if (mode === "login" && providerId !== undefined) {
    await runtime.login(providerId, "oauth", {
      signal: cancel.signal,
      prompt: (prompt) =>
        new Promise<string>((resolve, reject) => {
          const id = String(nextId++);
          waiting.set(id, { resolve, reject });
          const { signal: _signal, ...shown } = prompt;
          send({ type: "prompt", id, prompt: shown });
        }),
      notify: (event) => send({ type: "notify", event }),
    }, { getDeviceId: () => settings.getOrCreateDeviceId() });
  } else if (mode === "logout" && providerId !== undefined) {
    await runtime.logout(providerId);
  } else {
    throw new Error(`usage: login-helper.ts list | login <provider> | logout <provider>`);
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
