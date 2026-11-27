// harness-agent: one pi session in its own process, driven over HAP on fd 3 (a socket pair the hub
// opens; stdout and stderr stay free for diagnostics, so no stray print can corrupt the stream).
//
//   harness-agent --cwd <dir> [--session-file <path>] [--parent-session <path>] [--subagent <json>]
//
// Exits on EOF of the stream or SIGTERM, after disposing the runtime.

import { Socket } from "node:net";
import { parseArgs } from "node:util";
import { decodeRecord, encodeRecord, LineDecoder } from "#protocol/framing.ts";
import type { HapEvent } from "#protocol/hap.ts";
import { layoutOf } from "#protocol/layout.ts";
import { errorFields } from "#protocol/log.ts";
import { agentLogger } from "./agent-log.ts";
import type { HarnessState, SubagentLaunch } from "#protocol/state.ts";
import { HubChildren } from "./children.ts";
import { createHarnessExtension } from "#extension/index.ts";
import { HapServer } from "./hap-server.ts";
import { InteractionHub } from "./interactions.ts";
import { bundleLayout, dataDir } from "./paths.ts";
import { createHarnessRuntime } from "./runtime.ts";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cwd: { type: "string" },
      "session-file": { type: "string" },
      "parent-session": { type: "string" },
      subagent: { type: "string" },
      stdio: { type: "boolean" },
    },
  });
  const cwd = values.cwd ?? process.cwd();
  const home = dataDir();
  const layout = layoutOf(home);
  // pi reads its agent directory (settings, auth, models, MCP servers) from here, extensions included.
  process.env.PI_CODING_AGENT_DIR = layout.agent;
  process.env.PI_SKIP_VERSION_CHECK = "1";
  process.env.PI_CACHE_RETENTION ??= "long";
  process.chdir(cwd);

  const stream = values.stdio === true ? undefined : new Socket({ fd: 3, readable: true, writable: true });
  const write = (record: object): void => {
    const line = encodeRecord(record);
    if (stream !== undefined) {
      stream.write(line);
    } else {
      process.stdout.write(line);
    }
  };

  const log = agentLogger(write);
  // an error nothing caught ends the agent as before; the log has it first, with its stack
  const fatal = (event: string, error: unknown): void => {
    log.error(event, errorFields(error));
    process.stderr.write(`[harness-agent] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  };
  process.on("uncaughtException", (error) => fatal("uncaught", error));
  process.on("unhandledRejection", (reason) => fatal("unhandled_rejection", reason));

  let server: HapServer | undefined;
  const pending: HapEvent[] = [];
  const emit = (event: HapEvent): void => {
    if (server !== undefined) {
      server.emit(event);
    } else {
      pending.push(event); // state published while the runtime starts: sent after hello
    }
  };

  const hub = new InteractionHub(emit, log);
  const children = new HubChildren((frame) => write({ type: "harness_hub", frame }));
  const { factory, controller } = createHarnessExtension({
    interactions: hub,
    publishState: (state: HarnessState) => emit({ type: "harness_state", state }),
    publishClaude: (session, entries, streaming) => emit({ type: "harness_subagent_entries", session, entries, streaming }),
    dataDir: home,
    children,
    subagent: values.subagent !== undefined ? (JSON.parse(values.subagent) as SubagentLaunch) : undefined,
  });

  const bundle = bundleLayout();
  const runtime = await createHarnessRuntime({
    cwd,
    agentDir: layout.agent,
    sessionsDir: layout.sessions,
    sessionFile: values["session-file"],
    parentSession: values["parent-session"],
    extensionFactories: [factory],
    extensionPaths: bundle.extensionPaths,
    skillPaths: bundle.skillPaths,
    openUrl: (url) => emit({ type: "harness_ui", method: "open_url", url }),
  });
  for (const diagnostic of runtime.takeUnreportedDiagnostics()) {
    process.stderr.write(`[harness-agent] ${diagnostic.type}: ${diagnostic.message}\n`);
    log.log(diagnostic.type === "error" ? "error" : "warn", "diagnostic", { kind: diagnostic.type, message: diagnostic.message });
  }
  const session = runtime.session;
  log.info("agent_start", {
    harness: bundle.version,
    node: process.version,
    pid: process.pid,
    cwd,
    sessionFile: session.sessionFile,
    sessionId: session.sessionId,
    model: session.model !== undefined ? `${session.model.provider}/${session.model.id}` : undefined,
    extensions: bundle.extensionPaths.length,
  });

  server = new HapServer({ runtime, controller, hub, harnessVersion: bundle.version, output: write, onNodeFrame: (frame) => children.receive(frame), log });
  await server.start();
  for (const event of pending.splice(0)) {
    server.emit(event);
  }
  children.ready();

  let stopping = false;
  const shutdown = async (code: number): Promise<void> => {
    if (stopping) {
      return;
    } else {
      stopping = true;
      await controller.supervisor.stopAll("the agent is shutting down");
      await server?.dispose();
      process.exit(code);
    }
  };

  const decoder = new LineDecoder();
  const onLine = (line: string): void => {
    const decoded = decodeRecord(line);
    if (decoded.ok) {
      void server?.handle(decoded.record);
    } else {
      write({ type: "harness_response", id: "", ok: false, error: { code: "invalid_record", message: decoded.error } });
    }
  };
  const input = stream ?? process.stdin;
  input.on("data", (chunk: Buffer) => decoder.push(chunk).forEach(onLine));
  input.on("end", () => {
    decoder.end().forEach(onLine);
    void shutdown(0);
  });
  process.on("SIGTERM", () => void shutdown(143));
  process.on("SIGHUP", () => void shutdown(129));
}

main().catch((error: unknown) => {
  process.stderr.write(`[harness-agent] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
