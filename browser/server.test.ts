/**
 * The browser MCP server: its pure parts, and the server itself over stdio
 * against the bundle's browser ($HARNESS_MANIFEST, as nix/test.sh sets it),
 * offline on data: pages and without a display.
 */

import { McpClient, StdioTransport, type CallToolResult } from "@earendil-works/pi-mcp";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { browserExecutable, canShowWindow, majorVersion, regularUserAgent, reopenedNote, toContent } from "./browser.ts";

describe("pure parts", () => {
  test("browserExecutable: the user's browser wins over the bundled one", () => {
    assert.deepEqual(browserExecutable({ HARNESS_BROWSER: "/own", HARNESS_BUNDLED_BROWSER: "/bundled" }), { path: "/own" });
    assert.deepEqual(browserExecutable({ HARNESS_BUNDLED_BROWSER: "/bundled" }), { path: "/bundled" });
    assert.ok("problem" in browserExecutable({}));
  });

  test("majorVersion reads Chromium and Chrome version lines", () => {
    assert.deepEqual(majorVersion("Chromium 157.0.8103.50 \n"), { major: "157" });
    assert.deepEqual(majorVersion("Google Chrome 157.0.8103.51"), { major: "157" });
    assert.ok("problem" in majorVersion("no version here"));
  });

  test("regularUserAgent per platform, never headless", () => {
    assert.equal(
      regularUserAgent("157", "linux", "x64"),
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
    );
    assert.match(regularUserAgent("157", "linux", "arm64"), /\(X11; Linux aarch64\)/);
    assert.match(regularUserAgent("157", "darwin", "arm64"), /\(Macintosh; Intel Mac OS X 10_15_7\)/);
    assert.throws(() => regularUserAgent("157", "win32", "x64"), /unsupported platform/);
  });

  test("canShowWindow: Linux needs a display, macOS always has one", () => {
    assert.equal(canShowWindow("linux", {}), false);
    assert.equal(canShowWindow("linux", { DISPLAY: ":0" }), true);
    assert.equal(canShowWindow("linux", { WAYLAND_DISPLAY: "wayland-0" }), true);
    assert.equal(canShowWindow("darwin", {}), true);
  });

  test("toContent: text, images, JSON, nothing", () => {
    assert.deepEqual(toContent("hi"), { type: "text", text: "hi" });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    assert.deepEqual(toContent(png), { type: "image", data: png.toString("base64"), mimeType: "image/png" });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    assert.deepEqual(toContent(jpeg), { type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" });
    assert.throws(() => toContent(Buffer.from([1, 2, 3, 4])), /not a PNG or JPEG/);
    assert.deepEqual(toContent({ a: 1 }), { type: "text", text: '{\n  "a": 1\n}' });
    assert.deepEqual(toContent(undefined), { type: "text", text: "(the script returned nothing)" });
    assert.throws(() => toContent(() => 1), /no JSON form/);
  });
});

describe("server over stdio", () => {
  const manifest = JSON.parse(readFileSync(process.env.HARNESS_MANIFEST ?? "", "utf8")) as { bin: Record<string, string> };
  const server = join(dirname(fileURLToPath(import.meta.url)), "server.ts");
  let home: string;
  let client: McpClient;

  before(async () => {
    home = await mkdtemp(join(tmpdir(), "harness-browser-test-"));
    client = new McpClient({ name: "browser-test", version: "1.0.0", requestTimeoutMs: 60_000 });
    await client.connect(
      new StdioTransport({
        command: manifest.bin.node,
        args: [server],
        // no DISPLAY: `show` must refuse; no HARNESS_BROWSER: the bundled browser runs
        env: { HOME: home, PATH: process.env.PATH ?? "", HARNESS_BUNDLED_BROWSER: manifest.bin.browser },
        inheritEnv: false,
      }),
    );
  });

  after(async () => {
    await client.close();
    await rm(home, { recursive: true, force: true });
  });

  const text = (result: CallToolResult): string =>
    result.content.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");

  test("lists run and show", async () => {
    assert.deepEqual((await client.listTools()).map((tool) => tool.name).sort(), ["run", "show"]);
  });

  test("run: no automation marks, the regular user agent", async () => {
    const result = await client.callTool("run", {
      profile: join(home, "profile"),
      url: "data:text/html,<p id=x>one</p>",
      script: "return { webdriver: await page.evaluate(() => navigator.webdriver), ua: await page.evaluate(() => navigator.userAgent) };",
    });
    assert.equal(result.isError, undefined, text(result));
    const seen = JSON.parse(text(result)) as { webdriver: boolean; ua: string };
    assert.equal(seen.webdriver, false);
    assert.doesNotMatch(seen.ua, /Headless/);
    assert.match(seen.ua, /Chrome\/\d+\.0\.0\.0/);
  });

  test("run: the page stays open between calls", async () => {
    const profile = join(home, "profile");
    const first = await client.callTool("run", {
      profile,
      url: "data:text/html,<p id=x>one</p>",
      script: 'await page.evaluate(() => { document.getElementById("x").textContent = "two"; }); return "changed";',
    });
    assert.equal(first.isError, undefined, text(first));
    const second = await client.callTool("run", { profile, script: 'return await page.locator("#x").textContent();' });
    assert.equal(text(second), "two");
  });

  test("run: a screenshot comes back as an image", async () => {
    const result = await client.callTool("run", { profile: join(home, "profile"), script: "return await page.screenshot();" });
    assert.equal(result.content[0]?.type, "image");
  });

  test("run: a browser closed in the meantime reopens headless at its last page, with a note", async () => {
    const profile = join(home, "profile");
    const url = "data:text/html,<p id=x>before close</p>";
    const closing = await client.callTool("run", { profile, url, script: "await context.close();" });
    assert.equal(closing.isError, undefined, text(closing));
    const reopened = await client.callTool("run", { profile, script: "return page.url();" });
    assert.deepEqual(reopened.content, [
      { type: "text", text: reopenedNote(url) },
      { type: "text", text: url },
    ]);
  });

  test("run: a failing script is an error result", async () => {
    const result = await client.callTool("run", { profile: join(home, "profile"), script: 'throw new Error("boom");' });
    assert.equal(result.isError, true);
    assert.match(text(result), /boom/);
  });

  test("show: refused without a display", async () => {
    const result = await client.callTool("show", { profile: join(home, "profile") });
    assert.equal(result.isError, true);
    assert.match(text(result), /no display/);
  });
});
