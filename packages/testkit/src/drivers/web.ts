// The app's web build as a test client: `harness web-app`'s server on the stand's node, the bundle's
// browser driven by Playwright. Verdicts read what a user's assistive technology reads — roles and
// accessible names (ARIA) — and the screen state the page publishes; screenshots are for looking.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import type { Transport } from "#protocol/node.ts";
import { startWebApp, type WebApp } from "#node/webapp.ts";
import { appWebDir } from "#node/endpoints/static.ts";
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
  private readonly app: WebApp;

  private constructor(browser: Browser, page: Page, app: WebApp) {
    this.browser = browser;
    this.page = page;
    this.app = app;
  }

  /** Whether this machine can run it: the app's web build and the bundle's browser. */
  static available(): string | undefined {
    return appWebDir() === undefined ? "no web build of the app (HARNESS_APP_WEB)" : bundledBrowser() === undefined ? "no bundle browser (HARNESS_MANIFEST)" : undefined;
  }

  static async start(open: () => Promise<Transport>, options: WebDriverOptions = {}): Promise<WebDriver> {
    const staticDir = appWebDir();
    const executablePath = bundledBrowser();
    if (staticDir === undefined || executablePath === undefined) {
      throw new Error(`the web driver needs ${WebDriver.available()}`);
    } else {
      const app = await startWebApp({ staticDir, open });
      const { chromium } = await import("playwright-core");
      const browser = await chromium.launch({ executablePath, args: ["--no-sandbox", "--font-render-hinting=none", "--force-color-profile=srgb"] });
      const page = await browser.newPage({ viewport: { width: options.width ?? 1400, height: options.height ?? 900 }, deviceScaleFactor: 1 });
      await page.goto(app.url);
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
    this.app.close();
  }
}
