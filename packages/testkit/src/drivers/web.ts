// The app's web build as a test client: `harness web-app`'s server on the stand's hub, the bundle's
// browser driven by Playwright. Verdicts read what a user's assistive technology reads — roles and
// accessible names (ARIA) — and the screen state the page publishes; screenshots are for looking.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import type { Transport } from "#protocol/hub.ts";
import { startWebApp, type WebApp } from "#hub/webapp.ts";
import { appWebDir } from "#hub/endpoints/static.ts";
import { bundledBrowser } from "../capture/rasterize.ts";

export type WebDriverOptions = { width?: number; height?: number };

/** What the page publishes of its workbench (App.tsx, `window.__harnessScreen`). */
export type WebScreen = {
  tabs: { title: string; glyph: string; node: string }[];
  active: number;
  items: { label: string; glyph: string; kind: string }[];
  editor: string;
  overlays: string[];
  status: string[];
};

export class WebDriver {
  readonly page: Page;
  private readonly browser: Browser;
  /** The web server this driver started (a stand's); undefined when a hub serves the app (the product). */
  private readonly app: WebApp | undefined;

  private constructor(browser: Browser, page: Page, app: WebApp | undefined) {
    this.browser = browser;
    this.page = page;
    this.app = app;
  }

  /** Whether this machine can run it: the app's web build and the bundle's browser. */
  static available(): string | undefined {
    return appWebDir() === undefined ? "no web build of the app (HARNESS_APP_WEB)" : bundledBrowser() === undefined ? "no bundle browser (HARNESS_MANIFEST)" : undefined;
  }

  /** The app on a web server of its own over a stand's hub. */
  static async start(open: () => Promise<Transport>, options: WebDriverOptions = {}): Promise<WebDriver> {
    const staticDir = appWebDir();
    if (staticDir === undefined) {
      throw new Error(`the web driver needs ${WebDriver.available()}`);
    } else {
      const app = await startWebApp({ staticDir, open });
      return await WebDriver.launch(app.url, app, options);
    }
  }

  /** The app a hub serves, at `url` (a pairing link: the page pairs, gets its cookie and connects). */
  static open(url: string, options: WebDriverOptions = {}): Promise<WebDriver> {
    return WebDriver.launch(url, undefined, options);
  }

  private static async launch(url: string, app: WebApp | undefined, options: WebDriverOptions): Promise<WebDriver> {
    const executablePath = bundledBrowser();
    if (executablePath === undefined) {
      throw new Error(`the web driver needs ${WebDriver.available()}`);
    } else {
      const { chromium } = await import("playwright-core");
      // a fake microphone (a tone) that needs no permission prompt: voice input runs unattended
      const browser = await chromium.launch({
        executablePath,
        args: ["--no-sandbox", "--font-render-hinting=none", "--force-color-profile=srgb", "--disable-lcd-text", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
        // the page's own fonts, drawn the same on every machine: no system fonts, one way of rasterizing
        env: { ...process.env, FONTCONFIG_FILE: plainFontconfig() },
      });
      const page = await browser.newPage({ viewport: { width: options.width ?? 1400, height: options.height ?? 900 }, deviceScaleFactor: 1 });
      await page.goto(url);
      await page.getByRole("tablist", { name: "sessions" }).waitFor({ timeout: 30_000 });
      return new WebDriver(browser, page, app);
    }
  }

  screen(): Promise<WebScreen> {
    return this.page.evaluate(() => (window as unknown as { __harnessScreen: () => WebScreen }).__harnessScreen());
  }

  /** Resolves when `predicate` holds for the published screen. */
  async waitForScreen(predicate: (screen: WebScreen) => boolean, timeoutMs = 15_000): Promise<WebScreen> {
    const started = Date.now();
    for (;;) {
      const screen = await this.screen();
      if (predicate(screen)) {
        return screen;
      } else if (Date.now() - started > timeoutMs) {
        throw new Error(`the web screen never matched; it is:\n${JSON.stringify(screen, null, 2)}`);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  async type(text: string): Promise<void> {
    await this.page.getByRole("textbox", { name: "Message" }).fill(text);
  }

  async submit(): Promise<void> {
    await this.page.getByRole("textbox", { name: "Message" }).press("Control+Enter");
  }

  /**
   * A key by pi-tui's name (`ctrl+n`, `alt+/`, `escape`, `pageDown`), as a browser reports it: by
   * the key's place (`KeyN`, `Slash`), so the app's code-based keys see what a keyboard sends.
   */
  async key(id: string): Promise<void> {
    const parts = id.endsWith("++") ? [...id.slice(0, -2).split("+"), "+"] : id.split("+");
    const name = parts.at(-1) ?? "";
    const named: Record<string, string> = {
      escape: "Escape",
      enter: "Enter",
      tab: "Tab",
      backspace: "Backspace",
      delete: "Delete",
      up: "ArrowUp",
      down: "ArrowDown",
      left: "ArrowLeft",
      right: "ArrowRight",
      home: "Home",
      end: "End",
      pageUp: "PageUp",
      pageDown: "PageDown",
      space: "Space",
      "/": "Slash",
      "\\": "Backslash",
    };
    const key = named[name] ?? (/^[a-z]$/.test(name) ? `Key${name.toUpperCase()}` : /^[0-9]$/.test(name) ? `Digit${name}` : name);
    const modifiers = [parts.includes("ctrl") ? "Control" : undefined, parts.includes("alt") ? "Alt" : undefined, parts.includes("shift") ? "Shift" : undefined].filter((part) => part !== undefined);
    await this.page.keyboard.press([...modifiers, key].join("+"));
  }

  /** Text typed where the keyboard is (the message, a dialog's field, the folder list). */
  async keys(text: string): Promise<void> {
    await this.page.keyboard.type(text);
  }

  /** The page's visible text. */
  text(): Promise<string> {
    return this.page.locator("body").innerText();
  }

  async waitForText(predicate: (text: string) => boolean, timeoutMs = 20_000): Promise<string> {
    const started = Date.now();
    for (;;) {
      const text = await this.text();
      if (predicate(text)) {
        return text;
      } else if (Date.now() - started > timeoutMs) {
        throw new Error(`the web page never matched; it shows:\n${text}`);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  aria(): Promise<string> {
    return this.page.locator("body").ariaSnapshot();
  }

  /** screen.png and aria.yml into `dir`. */
  async capture(dir: string, name = "screen"): Promise<string[]> {
    const png = join(dir, `${name}.png`);
    const aria = join(dir, `${name}.aria.yml`);
    await this.page.screenshot({ path: png });
    writeFileSync(aria, await this.aria());
    return [png, aria];
  }

  stop(): void {
    void this.browser.close();
    this.app?.close();
  }
}

let fontconfig: string | undefined;

/** A fontconfig without the machine's fonts and with one way of rasterizing (grayscale, unhinted). */
function plainFontconfig(): string {
  if (fontconfig === undefined) {
    const dir = mkdtempSync(join(tmpdir(), "fc-"));
    fontconfig = join(dir, "fonts.conf");
    writeFileSync(
      fontconfig,
      `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <cachedir>${dir}/cache</cachedir>
  <match target="font">
    <edit name="antialias" mode="assign"><bool>true</bool></edit>
    <edit name="hinting" mode="assign"><bool>false</bool></edit>
    <edit name="rgba" mode="assign"><const>none</const></edit>
    <edit name="lcdfilter" mode="assign"><const>lcdnone</const></edit>
  </match>
</fontconfig>
`,
    );
  } else {
    // written once per process
  }
  return fontconfig;
}
