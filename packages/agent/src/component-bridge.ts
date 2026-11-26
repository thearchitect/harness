// The component bridge: an extension's pi-tui component (ctx.ui.custom) runs here, in the agent,
// and terminal clients show it. Each requested render goes out as ANSI lines at the width the
// clients reported; their keys come back as terminal input; `done` closes it on every client.
// Component widgets are drawn the same way into widget lines. The clients' pointer comes back as
// mouse events at a cell, their height as the terminal's rows. Without a client that can draw
// components (none attached in full with the capability), custom() waits for one and says so in the
// status line.

import { getKeybindings, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { BridgedComponent, ComponentMouse, HapEvent } from "#protocol/hap.ts";

/** What a factory receives as `tui`: render requests and the terminal's size. */
type BridgeTui = { requestRender(force?: boolean): void; terminal: { columns: number; rows: number } };

type Open = { id: string; component: Component; overlay: boolean; lines: string[]; scheduled: boolean };

type Factory<T> = (tui: BridgeTui, theme: Theme, keybindings: unknown, done: (result: T) => void) => Component | Promise<Component>;

const DEFAULT_WIDTH = 100;
const DEFAULT_ROWS = 40;
/** The status line's key while a component waits for a client that can show it. */
const WAITING_STATUS = "harness-component";

export class ComponentBridge {
  private readonly emit: (event: HapEvent) => void;
  private readonly theme: () => Theme;
  private readonly open = new Map<string, Open>();
  private counter = 0;
  private width = DEFAULT_WIDTH;
  private rows = DEFAULT_ROWS;
  /** Clients that can draw components (the node's harness_clients). */
  private clients = 0;
  /** Components waiting for such a client. */
  private readonly waiting: (() => void)[] = [];

  constructor(emit: (event: HapEvent) => void, theme: () => Theme) {
    this.emit = emit;
    this.theme = theme;
  }

  /** How many attached clients can show components now; components waiting for one open when one comes. */
  setClients(count: number): void {
    this.clients = count;
    if (count > 0 && this.waiting.length > 0) {
      this.emit({ type: "harness_ui", method: "status", key: WAITING_STATUS });
      for (const open of this.waiting.splice(0)) {
        open();
      }
    } else {
      // nobody waits, or still no client
    }
  }

  private tui(render: () => void): BridgeTui {
    const bridge = this;
    return {
      requestRender: render,
      terminal: {
        get columns() {
          return bridge.width;
        },
        get rows() {
          return bridge.rows;
        },
      },
    };
  }

  /** ctx.ui.custom: the component's result once a client that can show it answers it. */
  async custom<T>(factory: Factory<T>, options?: { overlay?: boolean }): Promise<T | undefined> {
    if (this.clients === 0) {
      this.emit({ type: "harness_ui", method: "status", key: WAITING_STATUS, text: "an extension's dialog waits for a client that can show it (harness, the app)" });
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      // a client shows it now
    }
    {
      this.counter += 1;
      const id = `c${this.counter}`;
      return await new Promise<T | undefined>((resolve, reject) => {
        let entry: Open | undefined;
        const render = (): void => this.schedule(id);
        const done = (result: T): void => {
          this.close(id);
          resolve(result);
        };
        Promise.resolve(factory(this.tui(render), this.theme(), getKeybindings(), done))
          .then((component) => {
            entry = { id, component, overlay: options?.overlay === true, lines: [], scheduled: false };
            this.open.set(id, entry);
            this.emit({ type: "harness_component_open", componentId: id, overlay: entry.overlay });
            this.draw(entry);
          })
          .catch(reject);
      });
    }
  }

  /** A component widget: drawn into lines at the clients' width on every render request. */
  widget(factory: (tui: BridgeTui, theme: Theme) => Component, send: (lines: string[]) => void): () => void {
    let component: Component | undefined;
    let disposed = false;
    const draw = (): void => {
      if (component !== undefined && !disposed) {
        send([...component.render(this.width)]);
      } else {
        // not built yet, or removed
      }
    };
    component = factory(this.tui(() => queueMicrotask(draw)), this.theme());
    draw();
    return () => {
      disposed = true;
      (component as { dispose?: () => void } | undefined)?.dispose?.();
    };
  }

  private schedule(id: string): void {
    const entry = this.open.get(id);
    if (entry !== undefined && !entry.scheduled) {
      entry.scheduled = true;
      queueMicrotask(() => {
        entry.scheduled = false;
        this.draw(entry);
      });
    } else {
      // closed, or a render is pending
    }
  }

  private draw(entry: Open): void {
    if (this.open.get(entry.id) === entry) {
      entry.lines = [...entry.component.render(this.width)];
      this.emit({ type: "harness_component_render", componentId: entry.id, lines: entry.lines });
    } else {
      // closed meanwhile
    }
  }

  private close(id: string): void {
    const entry = this.open.get(id);
    if (entry !== undefined) {
      this.open.delete(id);
      (entry.component as { dispose?: () => void }).dispose?.();
      this.emit({ type: "harness_component_close", componentId: id });
    } else {
      // closed already
    }
  }

  input(componentId: string, data: string): void {
    const entry = this.open.get(componentId);
    if (entry === undefined) {
      throw new Error(`no component ${componentId}`);
    } else {
      entry.component.handleInput?.(data);
      this.schedule(componentId);
    }
  }

  /** The pointer at a cell of a component: its handleMouse gets it as pi-tui's TUI would give it. */
  mouse(componentId: string, event: ComponentMouse): void {
    const entry = this.open.get(componentId);
    if (entry === undefined) {
      throw new Error(`no component ${componentId}`);
    } else {
      const handler = (entry.component as { handleMouse?: (event: TuiMouseEvent) => unknown }).handleMouse;
      handler?.call(entry.component, {
        type: event.type,
        button: event.button,
        x: event.x,
        y: event.y,
        screenX: event.x,
        screenY: event.y,
        width: this.width,
        height: entry.lines.length,
        shift: false,
        alt: false,
        ctrl: false,
        ...(event.wheelDelta !== undefined ? { wheelDelta: event.wheelDelta } : {}),
        ...(event.type === "click" ? { clickCount: 1 } : {}),
      });
      this.schedule(componentId);
    }
  }

  resize(componentId: string, width: number, rows?: number): void {
    this.width = width;
    this.rows = rows ?? this.rows;
    const entry = this.open.get(componentId);
    if (entry !== undefined) {
      entry.component.invalidate();
      this.schedule(componentId);
    } else {
      // closed meanwhile
    }
  }

  snapshot(): BridgedComponent[] {
    return [...this.open.values()].map((entry) => ({ componentId: entry.id, overlay: entry.overlay, lines: entry.lines }));
  }
}
