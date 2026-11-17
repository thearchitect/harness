/**
 * harness - the real browser behind the `browser` MCP server (server.ts).
 *
 * Chromium driven through Patchright - the Playwright API without automation
 * marks (no navigator.webdriver, no Runtime.enable) - on a persistent profile,
 * so cookies and logins survive. Headless by default, with the user agent of
 * the regular browser; `show` hands the same profile to the operator in a
 * visible window and resumes headless at the page the operator left.
 *
 * One browser at a time, owned by the server process: pi starts the server
 * with the session and stops it on exit, which closes the browser.
 */

import { chromium, type BrowserContext, type Page } from "patchright";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

/** Patchright's default action and navigation timeout, in ms. */
const DEFAULT_TIMEOUT_MS = 30_000;

/* ----------------------------------------------------------------------------
 * Pure parts
 * ------------------------------------------------------------------------- */

/** The browser executable: the user's HARNESS_BROWSER, else the bundle's. */
export function browserExecutable(env: NodeJS.ProcessEnv): { path: string } | { problem: string } {
  const own = env.HARNESS_BROWSER;
  const bundled = env.HARNESS_BUNDLED_BROWSER;
  if (own) {
    return { path: own };
  } else if (bundled) {
    return { path: bundled };
  } else {
    return { problem: "no browser: set HARNESS_BROWSER to a Chrome/Chromium executable" };
  }
}

/** The major version in `<browser> --version` ("Chromium 157.0.8103.50", "Google Chrome 157.0.8103.51"). */
export function majorVersion(versionOutput: string): { major: string } | { problem: string } {
  const match = /(\d+)\.\d+\.\d+\.\d+/.exec(versionOutput);
  if (match) {
    return { major: match[1] };
  } else {
    return { problem: `cannot read the browser version from "${versionOutput.trim()}"` };
  }
}

/**
 * The user agent the regular browser of this platform sends: headless
 * Chromium announces itself as HeadlessChrome, which sites treat as a bot.
 */
export function regularUserAgent(major: string, platform: NodeJS.Platform, arch: string): string {
  let system: string;
  switch (platform) {
    case "linux":
      system = `X11; Linux ${arch === "arm64" ? "aarch64" : "x86_64"}`;
      break;
    case "darwin":
      // Chrome reports this frozen value on every Mac.
      system = "Macintosh; Intel Mac OS X 10_15_7";
      break;
    default:
      throw new Error(`unsupported platform: ${platform}`);
  }
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** Whether a window can be shown to the operator here (not on a headless server). */
export function canShowWindow(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  switch (platform) {
    case "linux":
      return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
    case "darwin":
      return true;
    default:
      return false;
  }
}

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/**
 * A script's return value as MCP content: a string as text, the bytes of a
 * PNG or JPEG (page.screenshot()) as an image, anything else as JSON.
 */
export function toContent(value: unknown): Content {
  if (typeof value === "string") {
    return { type: "text", text: value };
  } else if (value instanceof Uint8Array) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
      return { type: "image", data: bytes.toString("base64"), mimeType: "image/png" };
    } else if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
      return { type: "image", data: bytes.toString("base64"), mimeType: "image/jpeg" };
    } else {
      throw new Error(`the script returned ${bytes.length} bytes that are not a PNG or JPEG image`);
    }
  } else if (value === undefined) {
    return { type: "text", text: "(the script returned nothing)" };
  } else {
    const json = JSON.stringify(value, null, 2);
    if (json === undefined) {
      throw new Error(`the script returned a ${typeof value}, which has no JSON form`);
    } else {
      return { type: "text", text: json };
    }
  }
}

/* ----------------------------------------------------------------------------
 * The browser
 * ------------------------------------------------------------------------- */

type Session = { profile: string; context: BrowserContext; page: Page };

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...params: string[]
) => (page: Page, context: BrowserContext) => Promise<unknown>;

export class Browser {
  private session: Session | undefined;
  /** Calls run one at a time: codemode may send several at once to one page. */
  private queue: Promise<unknown> = Promise.resolve();
  /** The headless user agent, read from the executable once. */
  private userAgentValue: Promise<string> | undefined;

  private readonly executable: string;

  constructor(executable: string) {
    this.executable = executable;
  }

  /** Runs `script` (an async function body with `page` and `context`) on the live page of `profile`. */
  run(profile: string, url: string | undefined, script: string): Promise<Content> {
    return this.serialized(async () => {
      const session = await this.headless(resolve(profile));
      if (url !== undefined) {
        await session.page.goto(url);
      } else {
        // the script works on the current page
      }
      const fn = new AsyncFunction("page", "context", script);
      return toContent(await fn(session.page, session.context));
    });
  }

  /**
   * Shows `profile` to the operator in a visible window at `url` (default:
   * the current page) and waits until the operator closes it; then resumes
   * headless at the page the operator left. `onWaiting` runs periodically
   * while the window is open; `signal` closes the window early.
   */
  show(profile: string, url: string | undefined, onWaiting: () => void, signal: AbortSignal): Promise<string> {
    return this.serialized(async () => {
      const dir = resolve(profile);
      let lastUrl = url ?? (this.session?.profile === dir ? this.session.page.url() : "about:blank");
      await this.close();

      const visible = await this.launch(dir, true);
      const track = (page: Page): void => {
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame()) {
            lastUrl = frame.url();
          } else {
            // navigation inside a frame: the page stays where it is
          }
        });
      };
      visible.context.pages().forEach(track);
      visible.context.on("page", track);
      if (lastUrl !== "about:blank") {
        await visible.page.goto(lastUrl);
      } else {
        // nothing to reopen: the operator starts from a blank page
      }

      const closed = new Promise<void>((done) => visible.context.once("close", () => done()));
      const timer = setInterval(onWaiting, 15_000);
      const abort = (): void => void visible.context.close();
      signal.addEventListener("abort", abort, { once: true });
      try {
        await closed;
      } finally {
        clearInterval(timer);
        signal.removeEventListener("abort", abort);
      }

      this.session = await this.launch(dir, false);
      if (lastUrl !== "about:blank") {
        await this.session.page.goto(lastUrl);
      } else {
        // the operator left a blank page
      }
      return `the operator closed the window at ${lastUrl}`;
    });
  }

  /** Closes the browser, if one is open. */
  async close(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (session) {
      await session.context.close();
    } else {
      // no browser open
    }
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    // the queue only orders calls; each caller gets its own outcome from `result`
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** The headless session of `profile`: the open one, or a new one in place of another profile's. */
  private async headless(profile: string): Promise<Session> {
    const open = this.session;
    if (open && open.profile === profile) {
      if (open.page.isClosed()) {
        open.page = open.context.pages()[0] ?? (await open.context.newPage());
      } else {
        // the page the previous call left
      }
      return open;
    } else {
      await this.close();
      this.session = await this.launch(profile, false);
      return this.session;
    }
  }

  private async launch(profile: string, visible: boolean): Promise<Session> {
    await mkdir(profile, { recursive: true });
    let args: string[];
    if (visible) {
      // a visible window is the regular browser: its user agent is genuine
      args = [];
    } else {
      args = [`--user-agent=${await this.userAgent()}`];
    }
    const context = await chromium.launchPersistentContext(profile, {
      executablePath: this.executable,
      headless: !visible,
      args,
      ...(visible ? { viewport: null } : {}),
    });
    context.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
    const page = context.pages()[0] ?? (await context.newPage());
    return { profile, context, page };
  }

  private userAgent(): Promise<string> {
    this.userAgentValue ??= new Promise((done, fail) => {
      execFile(this.executable, ["--version"], { timeout: 10_000 }, (error, stdout) => {
        if (error) {
          fail(new Error(`${this.executable} --version: ${error.message}`));
        } else {
          const version = majorVersion(stdout);
          if ("major" in version) {
            done(regularUserAgent(version.major, process.platform, process.arch));
          } else {
            fail(new Error(version.problem));
          }
        }
      });
    });
    return this.userAgentValue;
  }
}
