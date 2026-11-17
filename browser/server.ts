/**
 * harness - the `browser` MCP server (stdio): a real Chromium for the hard
 * cases of web research - logins, bot checks, sites Lightpanda cannot render.
 * deps.ts registers it with codemode exposure; the browser itself is
 * browser.ts.
 *
 * Tools:
 * - run: Playwright code on the live page of a persistent profile;
 * - show: the same profile in a visible window, until the operator closes it.
 */

import { McpServer, type CallToolResult, type ServerContext } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";
import { Browser, browserExecutable, canShowWindow } from "./browser.ts";

const PROFILE = z
  .string()
  .describe("Profile directory, one per site: <session workspace>/browser/<site>. Cookies and logins persist in it.");

function failure(error: unknown): CallToolResult {
  return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
}

function serve(browser: Browser): void {
  serveStdio(() => {
    const server = new McpServer({ name: "browser", version: "1.0.0" }, { capabilities: { tools: {} } });

    server.registerTool(
      "run",
      {
        description: [
          "Run Playwright code on the live page of a persistent Chromium profile (Patchright: no automation marks; headless).",
          "`script` is the body of an async function with `page` and `context` in scope; its return value comes back:",
          "a string as text, a screenshot (`return await page.screenshot()`) as an image, anything else as JSON.",
          "The page stays open between calls; `url` navigates first. Another `profile` closes the current browser and opens that one.",
        ].join(" "),
        inputSchema: z.object({
          profile: PROFILE,
          url: z.string().optional().describe("Navigate here before the script runs"),
          script: z
            .string()
            .describe('Async function body, e.g. `await page.getByRole("link", { name: "Docs" }).click(); return await page.locator("body").ariaSnapshot();`'),
        }),
      },
      async ({ profile, url, script }): Promise<CallToolResult> => {
        try {
          return { content: [await browser.run(profile, url, script)] };
        } catch (error) {
          return failure(error);
        }
      },
    );

    server.registerTool(
      "show",
      {
        description: [
          "Show the browser to the operator: reopens `profile` in a visible window at `url` (default: the current page)",
          "and returns when the operator closes the window; `run` then continues headless at the page the operator left.",
          "Fails where no window can be shown (a server).",
        ].join(" "),
        inputSchema: z.object({
          profile: PROFILE,
          url: z.string().optional().describe("Open this page (default: the current page of the profile)"),
        }),
      },
      async ({ profile, url }, ctx: ServerContext): Promise<CallToolResult> => {
        if (!canShowWindow(process.platform, process.env)) {
          return failure("no display: a window cannot be shown here");
        } else {
          const progressToken = ctx.mcpReq._meta?.progressToken;
          let progress = 0;
          // progress keeps the call alive while the operator works in the window
          const onWaiting = (): void => {
            if (progressToken !== undefined) {
              progress += 1;
              void ctx.mcpReq
                .notify({ method: "notifications/progress", params: { progressToken, progress, message: "waiting for the operator to close the window" } })
                .catch((error: unknown) => console.error(`[browser] progress notification failed: ${String(error)}`));
            } else {
              // the client asked for no progress: nothing to report
            }
          };
          try {
            return { content: [{ type: "text", text: await browser.show(profile, url, onWaiting, ctx.mcpReq.signal) }] };
          } catch (error) {
            return failure(error);
          }
        }
      },
    );

    return server;
  });
}

const executable = browserExecutable(process.env);
if ("path" in executable) {
  const browser = new Browser(executable.path);
  const shutdown = (): void => {
    browser
      .close()
      .catch((error: unknown) => console.error(`[browser] closing the browser failed: ${String(error)}`))
      .finally(() => process.exit(0));
  };
  process.stdin.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  serve(browser);
} else {
  console.error(`[browser] ${executable.problem}`);
  process.exit(1);
}
