// The bridge between a Claude Code process and this agent (plan 12.4): a unix socket in
// ~/.harness/sockets (directory 0700) with a one-time token. `harness claude-bridge hook` sends
// Claude's PreToolUse hook input here and prints the decision; `harness claude-bridge mcp` relays
// Claude's MCP messages, answered here: harness's tools (run through the calling tool's context,
// so gates, secrets masking and "/-" apply) and the `permission` tool for ask rules.

import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import type { BridgeRequest, ClaudeHookInput, ClaudeHookOutput } from "#protocol/claude.ts";
import { decodeRecord, encodeRecord, LineDecoder } from "#protocol/framing.ts";

export type Decision = { behavior: "allow" } | { behavior: "deny"; reason: string };

export type McpTool = { name: string; description: string; inputSchema: unknown };

export type BridgeHandlers = {
  decide(input: ClaudeHookInput): Promise<Decision>;
  tools(): McpTool[];
  callTool(name: string, args: unknown): Promise<{ text: string; isError: boolean }>;
};

type JsonRpc = { jsonrpc: "2.0"; id?: string | number; method?: string; params?: Record<string, unknown> };

export const PERMISSION_TOOL = "permission";

export class Bridge {
  readonly socket: string;
  readonly token = randomBytes(24).toString("hex");
  private readonly server: Server;
  private readonly handlers: BridgeHandlers;

  private constructor(socket: string, server: Server, handlers: BridgeHandlers) {
    this.socket = socket;
    this.server = server;
    this.handlers = handlers;
  }

  static async open(dataDir: string, handlers: BridgeHandlers): Promise<Bridge> {
    const dir = join(dataDir, "sockets");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const socket = join(dir, `claude-${randomUUID().slice(0, 8)}.sock`);
    let bridge: Bridge | undefined;
    const server = createServer((connection) => {
      const decoder = new LineDecoder();
      connection.on("data", (chunk: Buffer) => {
        for (const line of decoder.push(chunk)) {
          const decoded = decodeRecord(line);
          void (async (): Promise<unknown> => {
            if (!decoded.ok) {
              return { error: decoded.error };
            } else if (bridge === undefined) {
              return { error: "the bridge is starting" };
            } else {
              return bridge.answer(decoded.record as BridgeRequest);
            }
          })()
            .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }))
            .then((reply) => {
              if (reply !== undefined) {
                connection.write(encodeRecord(reply as object));
              } else {
                // a notification: no answer
              }
            });
        }
      });
      connection.on("error", () => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, () => resolve());
    });
    bridge = new Bridge(socket, server, handlers);
    return bridge;
  }

  /** One request; undefined for MCP notifications (no answer). */
  private async answer(request: BridgeRequest): Promise<unknown> {
    if (request.token !== this.token) {
      return { error: "unauthorized" };
    } else {
      switch (request.kind) {
        case "hook": {
          const decision = await this.handlers.decide(request.input);
          const output: ClaudeHookOutput = {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: decision.behavior,
              permissionDecisionReason: decision.behavior === "deny" ? decision.reason : "allowed by harness",
            },
          };
          return output;
        }
        case "mcp":
          return this.mcp(request.message as JsonRpc);
        default:
          throw new Error(`unknown bridge request: ${JSON.stringify(request satisfies never)}`);
      }
    }
  }

  private async mcp(message: JsonRpc): Promise<unknown> {
    const reply = (result: unknown): unknown => ({ jsonrpc: "2.0", id: message.id, result });
    if (message.id === undefined) {
      return undefined; // notifications/initialized and others
    } else {
      switch (message.method) {
        case "initialize":
          return reply({ protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "harness", version: "1" } });
        case "ping":
          return reply({});
        case "tools/list":
          return reply({
            tools: [
              ...this.handlers.tools(),
              {
                name: PERMISSION_TOOL,
                description: "harness's decision on a tool call that needs permission",
                inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, required: ["tool_name", "input"] },
              },
            ],
          });
        case "tools/call": {
          const name = String(message.params?.name ?? "");
          const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
          if (name === PERMISSION_TOOL) {
            const input = (args.input ?? {}) as Record<string, unknown>;
            const decision = await this.handlers.decide({ hook_event_name: "PermissionRequest", session_id: "", tool_name: String(args.tool_name ?? ""), tool_input: input, ...(typeof args.tool_use_id === "string" ? { tool_use_id: args.tool_use_id } : {}) });
            const text = JSON.stringify(decision.behavior === "allow" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: decision.reason });
            return reply({ content: [{ type: "text", text }] });
          } else {
            const outcome = await this.handlers.callTool(name, args);
            return reply({ content: [{ type: "text", text: outcome.text }], isError: outcome.isError });
          }
        }
        default:
          return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } };
      }
    }
  }

  close(): void {
    this.server.close();
    rmSync(this.socket, { force: true });
  }
}
