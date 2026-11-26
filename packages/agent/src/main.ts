// harness-agent: one pi session in its own process, driven over HAP on fd 3 (a socket pair the node
// opens; stdout and stderr stay free for diagnostics, so no stray print can corrupt the stream).
//
//   harness-agent --cwd <dir> [--session-file <path>] [--parent-session <path>] [--subagent <json>]
//
// Exits on EOF of the stream or SIGTERM, after disposing the runtime.

import { Socket } from "node:net";
import { parseArgs } from "node:util";
import { decodeRecord, encodeRecord, LineDecoder } from "#protocol/framing.ts";
import type { HapEvent } from "#protocol/hap.ts";
import type { HarnessState, SubagentLaunch } from "#protocol/state.ts";
import { NodeChildren } from "./children.ts";
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
  // pi reads its agent directory (settings, auth, sessions) from here, extensions included.
  process.env.PI_CODING_AGENT_DIR = home;
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

  let server: HapServer | undefined;
  const pending: HapEvent[] = [];
  const emit = (event: HapEvent): void => {
    if (server !== undefined) {
      server.emit(event);
    } else {
      pending.push(event); // state published while the runtime starts: sent after hello
    }
  };

  const hub = new InteractionHub(emit);
  const children = new NodeChildren((frame) => write({ type: "harness_node", frame }));
  const { factory, controller } = createHarnessExtension({
    interactions: hub,
    publishState: (state: HarnessState) => emit({ type: "harness_state", state }),
    dataDir: home,
    children,
    subagent: values.subagent !== undefined ? (JSON.parse(values.subagent) as SubagentLaunch) : undefined,
  });

  const layout = bundleLayout();
  const runtime = await createHarnessRuntime({
    cwd,
    agentDir: home,
    sessionFile: values["session-file"],
    parentSession: values["parent-session"],
    extensionFactories: [factory],
    extensionPaths: layout.extensionPaths,
    skillPaths: layout.skillPaths,
    openUrl: (url) => emit({ type: "harness_ui", method: "open_url", url }),
  });
  for (const diagnostic of runtime.takeUnreportedDiagnostics()) {
    process.stderr.write(`[harness-agent] ${diagnostic.type}: ${diagnostic.message}\n`);
  }

  server = new HapServer({ runtime, controller, hub, harnessVersion: layout.version, output: write, onNodeFrame: (frame) => children.receive(frame) });
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
