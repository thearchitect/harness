/**
 * harness - the real browser behind the `browser` MCP server (server.ts).
 *
 * Chromium driven through Patchright - the Playwright API without automation
 * marks (no navigator.webdriver, no Runtime.enable) - on a persistent profile,
 * so cookies and logins survive. Headless by default, with the user agent of
 * the regular browser; `show` reopens the same profile in a visible window for
 * the operator, and the model keeps working in it until the operator closes it.
 *
 * Switching between headless and visible restarts the browser: cookies and
 * storage persist in the profile, in-page state does not. Each switch is made
 * visible to the model: `show` returns the window's page, and a `run` that has
 * to reopen a closed browser says so before its result.
 *
 * One browser at a time, owned by the server process: pi starts the server
 * with the session and stops it on exit, which closes the browser.
 */

import { chromium, errors, type BrowserContext, type Page } from "patchright";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

/** Patchright's default action and navigation timeout, in ms. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** How long `show` lets a page settle before outlining it, in ms. */
const SETTLE_TIMEOUT_MS = 5_000;
/** The longest page outline `show` returns, in characters. */
const OUTLINE_LIMIT = 8_000;
const BLANK = "about:blank";

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

/** The note a `run` result starts with when the browser had to be reopened. */
export function reopenedNote(url: string): string {
  return `The browser had been closed; reopened headless at ${url}. In-page state was reset - inspect the page before acting on it.`;
}

/* ----------------------------------------------------------------------------
 * The browser
 * ------------------------------------------------------------------------- */

type Session = {
  profile: string;
  visible: boolean;
  context: BrowserContext;
  /** The page the tools work on. */
  page: Page;
  /** Where `page` last navigated: the page to reopen after the browser closed. */
  lastUrl: string;
  /** The browser closed under the server: the operator closed the window, or a script closed the context. */
  closed: boolean;
};

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...params: string[]
) => (page: Page, context: BrowserContext) => Promise<unknown>;

export class Browser {
  private readonly executable: string;
  /** The open browser, or the last one when it closed under the server (its `lastUrl` is reopened). */
  private session: Session | undefined;
  /** Calls run one at a time: codemode may send several at once to one page. */
  private queue: Promise<unknown> = Promise.resolve();
  /** The headless user agent, read from the executable once. */
  private userAgentValue: Promise<string> | undefined;

  constructor(executable: string) {
    this.executable = executable;
  }

  /**
   * Runs `script` (an async function body with `page` and `context`) on the
   * live page of `profile`, headless or in the operator's window. A browser
   * that closed under the server reopens headless at its last page, and the
   * result starts with a note saying so.
   */
  run(profile: string, url: string | undefined, script: string): Promise<Content[]> {
    return this.serialized(async () => {
      const dir = resolve(profile);
      const previous = this.session;
      const notes: Content[] = [];
      let session: Session;
      if (previous && previous.profile === dir && !previous.closed) {
        session = previous;
      } else if (previous && previous.profile === dir) {
        session = await this.open(dir, false, previous.lastUrl);
        notes.push({ type: "text", text: reopenedNote(previous.lastUrl) });
      } else {
        session = await this.open(dir, false, BLANK);
      }
      await livePage(session);

      if (url !== undefined) {
        await session.page.goto(url);
      } else {
        // the script works on the current page
      }
      const fn = new AsyncFunction("page", "context", script);
      return [...notes, toContent(await fn(session.page, session.context))];
    });
  }

  /**
   * Shows `profile` to the operator: reopens it in a visible window at `url`
   * (default: the current page) and returns at once, with the window's page -
   * URL, title and outline - as it is after the restart. An open window is
   * reused.
   */
  show(profile: string, url: string | undefined): Promise<string> {
    return this.serialized(async () => {
      const dir = resolve(profile);
      const previous = this.session;
      let session: Session;
      if (previous && previous.profile === dir && previous.visible && !previous.closed) {
        session = previous;
        await livePage(session);
        if (url !== undefined) {
          await session.page.goto(url);
        } else {
          // the window stays where the operator is
        }
      } else {
        const target = url ?? (previous && previous.profile === dir ? previous.lastUrl : BLANK);
        session = await this.open(dir, true, target);
      }
      return describe(session.page);
    });
  }

  /** Closes the browser, if one is open. */
  async close(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (session && !session.closed) {
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

  /** Replaces the current browser with `profile`, headless or visible, at `url`. */
  private async open(profile: string, visible: boolean, url: string): Promise<Session> {
    await this.close();
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
    const session: Session = { profile, visible, context, page, lastUrl: url, closed: false };

    context.on("close", () => {
      session.closed = true;
    });
    const track = (tab: Page): void => {
      tab.on("framenavigated", (frame) => {
        if (tab === session.page && frame === tab.mainFrame()) {
          session.lastUrl = frame.url();
        } else {
          // another tab, or a frame inside the page: the page to reopen stays
        }
      });
    };
    context.pages().forEach(track);
    context.on("page", track);

    this.session = session;
    if (url !== BLANK) {
      await page.goto(url);
    } else {
      // nothing to open: the page stays blank
    }
    return session;
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

/** Points the session at an open page when its page was closed (a closed tab or popup): the last tab, or a new one. */
async function livePage(session: Session): Promise<void> {
  if (session.page.isClosed()) {
    const open = session.context.pages();
    session.page = open[open.length - 1] ?? (await session.context.newPage());
    session.lastUrl = session.page.url();
  } else {
    // the page the previous call left
  }
}

/** The page as the operator sees it: URL, title and outline, after it settled. */
async function describe(page: Page): Promise<string> {
  let settled: string;
  try {
    await page.waitForLoadState("networkidle", { timeout: SETTLE_TIMEOUT_MS });
    settled = "";
  } catch (error) {
    if (error instanceof errors.TimeoutError) {
      settled = "\n(the page was still loading)";
    } else {
      throw error;
    }
  }
  const outline = await page.locator("body").ariaSnapshot();
  const shown = outline.length > OUTLINE_LIMIT ? `${outline.slice(0, OUTLINE_LIMIT)}\n[outline truncated]` : outline;
  return `Window open at ${page.url()} - "${await page.title()}"${settled}\n${shown}`;
}
