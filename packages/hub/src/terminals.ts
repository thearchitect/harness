// The operator's terminal of a session (plan polish-3 F): a shell in a pseudo-terminal in the
// session's directory, held by the hub (an agent unloads when idle; the terminal lives on). One per
// session, kept until its shell exits or the hub closes. A headless xterm mirrors its screen with
// 10 000 lines of history, so a client that opens it gets the screen as it is (serialized) and then
// the stream; every client sees the same screen, the size is the last one a client sent.

import nodePty from "node-pty";
import xterm from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import type { HubEvent } from "#protocol/hub.ts";

/** History lines a terminal keeps. */
export const TERMINAL_SCROLLBACK = 10_000;

type TerminalEvent = Extract<HubEvent, { ev: "terminal_output" | "terminal_exit" }>;

/** Who gets a terminal's events: a client connection (by identity). */
export type Viewer = object;

type Term = {
  session: string;
  cwd: string;
  pty: nodePty.IPty | undefined;
  mirror: InstanceType<typeof xterm.Terminal>;
  serializer: InstanceType<typeof serialize.SerializeAddon>;
  viewers: Set<Viewer>;
  exited: number | undefined;
  /**
   * Input that came before the shell was ready, written once it is: a starting shell sets its
   * terminal up (readline, fish) and discards what was typed before (TCSAFLUSH). Ready: its first
   * output, then a pause of READY_QUIET_MS (the prompt drawn). Undefined: ready.
   */
  held: string[] | undefined;
  readyTimer: ReturnType<typeof setTimeout> | undefined;
};

/** The pause after a starting shell's output that says its prompt is drawn. */
const READY_QUIET_MS = 40;

export type TerminalLog = (event: { event: "terminal_started"; session: string; cwd: string; pid: number } | { event: "terminal_exited"; session: string; code: number }) => void;

export class Terminals {
  private readonly terms = new Map<string, Term>();
  private readonly send: (viewer: Viewer, event: TerminalEvent) => void;
  private readonly log: TerminalLog;

  constructor(send: (viewer: Viewer, event: TerminalEvent) => void, log: TerminalLog) {
    this.send = send;
    this.log = log;
  }

  /**
   * A client shows a session's terminal: it starts (again, after its shell exited) and the client
   * gets the screen as it is; the stream follows.
   */
  async open(viewer: Viewer, session: string, cwd: string, cols: number, rows: number): Promise<{ screen: string }> {
    const known = this.terms.get(session);
    const term = known ?? this.made(session, cwd, cols, rows);
    if (term.pty === undefined) {
      this.start(term, cols, rows);
    } else {
      this.resize(session, cols, rows);
    }
    // the screen once every byte that came before is in the mirror; the bytes after go to the viewer too
    return new Promise((resolve) => {
      term.mirror.write("", () => {
        term.viewers.add(viewer);
        resolve({ screen: term.serializer.serialize({ scrollback: TERMINAL_SCROLLBACK }) });
      });
    });
  }

  input(session: string, data: string): void {
    const term = this.terms.get(session);
    if (term?.held !== undefined) {
      term.held.push(data);
    } else {
      term?.pty?.write(data);
    }
  }

  resize(session: string, cols: number, rows: number): void {
    const term = this.terms.get(session);
    const width = Math.max(2, Math.floor(cols));
    const height = Math.max(1, Math.floor(rows));
    if (term !== undefined && (term.mirror.cols !== width || term.mirror.rows !== height)) {
      term.mirror.resize(width, height);
      term.pty?.resize(width, height);
    } else {
      // no such terminal, or that size already
    }
  }

  /** A client hides it: the shell runs on, its screen keeps up here. */
  detach(viewer: Viewer, session: string): void {
    this.terms.get(session)?.viewers.delete(viewer);
  }

  disconnect(viewer: Viewer): void {
    for (const term of this.terms.values()) {
      term.viewers.delete(viewer);
    }
  }

  /** The hub closes: every shell ends. */
  closeAll(): void {
    for (const term of this.terms.values()) {
      clearTimeout(term.readyTimer);
      term.pty?.kill();
      term.mirror.dispose();
    }
    this.terms.clear();
  }

  private made(session: string, cwd: string, cols: number, rows: number): Term {
    const mirror = new xterm.Terminal({ cols: Math.max(2, cols), rows: Math.max(1, rows), scrollback: TERMINAL_SCROLLBACK, allowProposedApi: true });
    const serializer = new serialize.SerializeAddon();
    mirror.loadAddon(serializer as never);
    const term: Term = { session, cwd, pty: undefined, mirror, serializer, viewers: new Set(), exited: undefined, held: undefined, readyTimer: undefined };
    this.terms.set(session, term);
    return term;
  }

  private start(term: Term, cols: number, rows: number): void {
    const shell = process.env.SHELL !== undefined && process.env.SHELL !== "" ? process.env.SHELL : "/bin/sh";
    const pty = nodePty.spawn(shell, [], {
      name: "xterm-256color",
      cols: Math.max(2, cols),
      rows: Math.max(1, rows),
      cwd: term.cwd,
      env: { ...process.env, TERM: "xterm-256color", HARNESS_SESSION: term.session } as Record<string, string>,
    });
    term.pty = pty;
    term.exited = undefined;
    term.held = [];
    term.mirror.resize(Math.max(2, cols), Math.max(1, rows));
    // the mirror answers what the shell asks the terminal (device attributes, colors, the cursor's place): shells wait for it
    const answers = term.mirror.onData((data) => (term.pty === pty ? pty.write(data) : undefined));
    this.log({ event: "terminal_started", session: term.session, cwd: term.cwd, pid: pty.pid });
    pty.onData((data) => {
      if (term.held !== undefined && term.pty === pty) {
        // starting: ready once its output pauses
        clearTimeout(term.readyTimer);
        term.readyTimer = setTimeout(() => {
          const held = term.held ?? [];
          term.held = undefined;
          for (const typed of held) {
            pty.write(typed);
          }
        }, READY_QUIET_MS);
      } else {
        // ready
      }
      // to the viewers in the mirror's order: a viewer added after a screen gets what came after it
      term.mirror.write(data, () => {
        for (const viewer of term.viewers) {
          this.send(viewer, { ev: "terminal_output", session: term.session, data });
        }
      });
    });
    pty.onExit(({ exitCode }) => {
      answers.dispose();
      clearTimeout(term.readyTimer);
      term.held = undefined;
      term.mirror.write("", () => {
        if (term.pty === pty) {
          term.pty = undefined;
          term.exited = exitCode;
          this.log({ event: "terminal_exited", session: term.session, code: exitCode });
          for (const viewer of term.viewers) {
            this.send(viewer, { ev: "terminal_exit", session: term.session, code: exitCode });
          }
        } else {
          // a shell started again meanwhile
        }
      });
    });
  }
}
