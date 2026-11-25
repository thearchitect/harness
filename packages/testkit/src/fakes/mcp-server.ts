// A stdio MCP server for tests (`probe`): one tool, `echo`, that answers `echo: <text>`. Stands
// configure it in the agents' mcp.json to check what MCP integrations reach the models.

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";

export const MCP_PROBE_SERVER = "probe";

serveStdio(() => {
  const server = new McpServer({ name: MCP_PROBE_SERVER, version: "1.0.0" }, { capabilities: { tools: {} } });
  server.registerTool(
    "echo",
    {
      description: "Answers with the text it got",
      inputSchema: z.object({ text: z.string().describe("What to echo") }),
    },
    async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
  );
  return server;
});
