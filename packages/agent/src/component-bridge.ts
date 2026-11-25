// The component bridge: an extension's pi-tui component (ctx.ui.custom) runs here, in the agent,
// and terminal clients show it. Each requested render goes out as ANSI lines at the width the
// clients reported; their keys come back as terminal input; `done` closes it on every client.
// Component widgets are drawn the same way into widget lines. Without a client that can draw
// components (none attached in full with the capability), custom() resolves undefined at once, as
// in pi's RPC mode.

import { getKeybindings, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { BridgedComponent, HapEvent } from "#protocol/hap.ts";

/** What a factory receives as `tui`: render requests and the terminal's size. */
type BridgeTui = { requestRender(force?: boolean): void; terminal: { columns: number; rows: number } };

type Open = { id: string; component: Component; overlay: boolean; lines: string[]; scheduled: boolean };

type Factory<T> = (tui: BridgeTui, theme: Theme, keybindings: unknown, done: (result: T) => void) => Component | Promise<Component>;

const DEFAULT_WIDTH = 100;
const ROWS = 40;

export class ComponentBridge {
  private readonly emit: (event: HapEvent) => void;
  private readonly theme: () => Theme;
  private readonly open = new Map<string, Open>();
  private counter = 0;
  private width = DEFAULT_WIDTH;
  /** Clients that can draw components (the node's harness_clients). */
  clients = 0;

  constructor(emit: (event: HapEvent) => void, theme: () => Theme) {
    this.emit = emit;
    this.theme = theme;
  }

  private tui(render: () => void): BridgeTui {
    const width = (): number => this.width;
    return {
      requestRender: render,
      terminal: {
        get columns() {
          return width();
        },
        rows: ROWS,
      },
    };
  }

  /** ctx.ui.custom: the component's result, or undefined when no client can show it. */
  async custom<T>(factory: Factory<T>, options?: { overlay?: boolean }): Promise<T | undefined> {
    if (this.clients === 0) {
      return undefined;
    } else {
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

  resize(componentId: string, width: number): void {
    this.width = width;
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
