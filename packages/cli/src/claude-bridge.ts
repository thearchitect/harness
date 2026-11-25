// harness claude-bridge {mcp|hook}: what Claude Code runs on harness's behalf, relaying to the
// agent's bridge socket (HARNESS_BRIDGE_SOCKET, HARNESS_BRIDGE_TOKEN in Claude's environment).
//   hook — reads one PreToolUse input on stdin, prints the decision JSON, exits 0.
//   mcp  — an MCP server on stdio: every JSON-RPC message goes to the agent, answers come back.

import { createConnection, type Socket } from "node:net";
import { decodeRecord, encodeRecord, LineDecoder } from "#protocol/framing.ts";

function connect(): { socket: Socket; token: string } {
  const path = process.env.HARNESS_BRIDGE_SOCKET;
  const token = process.env.HARNESS_BRIDGE_TOKEN;
  if (path === undefined || path === "" || token === undefined || token === "") {
    process.stderr.write("harness claude-bridge: run by harness's Claude Code only (HARNESS_BRIDGE_SOCKET and HARNESS_BRIDGE_TOKEN missing)\n");
    process.exit(2);
  } else {
    return { socket: createConnection(path), token };
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    process.stdin.on("data", (chunk: Buffer) => (text += String(chunk)));
    process.stdin.on("end", () => resolve(text));
  });
}

async function hook(): Promise<void> {
  const input = JSON.parse(await readStdin()) as unknown;
  const { socket, token } = connect();
  const decoder = new LineDecoder();
  socket.on("data", (chunk: Buffer) => {
    for (const line of decoder.push(chunk)) {
      const decoded = decodeRecord(line);
      const reply = decoded.ok ? (decoded.record as { error?: string }) : { error: decoded.error };
      if (reply.error !== undefined) {
        // a failure denies: Claude must not act without harness's decision
        process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `harness: ${reply.error}` } })}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(reply)}\n`);
      }
      socket.end();
      process.exit(0);
    }
  });
  socket.on("error", (error) => {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `harness unreachable: ${error.message}` } })}\n`);
    process.exit(0);
  });
  socket.write(encodeRecord({ token, kind: "hook", input }));
}

function mcp(): void {
  const { socket, token } = connect();
  const fromAgent = new LineDecoder();
  socket.on("data", (chunk: Buffer) => {
    for (const line of fromAgent.push(chunk)) {
      process.stdout.write(`${line}\n`);
    }
  });
  socket.on("close", () => process.exit(0));
  socket.on("error", (error) => {
    process.stderr.write(`harness claude-bridge mcp: ${error.message}\n`);
    process.exit(1);
  });
  const fromClaude = new LineDecoder();
  process.stdin.on("data", (chunk: Buffer) => {
    for (const line of fromClaude.push(chunk)) {
      const decoded = decodeRecord(line);
      if (decoded.ok) {
        socket.write(encodeRecord({ token, kind: "mcp", message: decoded.record }));
      } else {
        process.stderr.write(`harness claude-bridge mcp: malformed message: ${decoded.error}\n`);
      }
    }
  });
  process.stdin.on("end", () => socket.end());
}

export async function claudeBridge(mode: string | undefined): Promise<void> {
  switch (mode) {
    case "hook":
      await hook();
      break;
    case "mcp":
      mcp();
      break;
    default:
      process.stderr.write("usage: harness claude-bridge mcp|hook (run by Claude Code)\n");
      process.exit(2);
  }
}

if (import.meta.main) {
  void claudeBridge(process.argv[2]);
}
