// Where everything of a user's harness lives under its home (~/.harness, or $HARNESS_HOME): one map,
// read by the hub, its agents, the clients and the migration from the old flat layout.
//
//   agent/    what pi reads (PI_CODING_AGENT_DIR): settings.json, auth.json, models.json, mcp*.json,
//             trust.json, keybindings.json, themes/, extensions/, skills/, subagents/
//   hub/      the hub's: settings.json, defaults.json, workspace.json, devices.json, pairings.json,
//             config.json, sessions/, attachments/, claude/, uploads/
//   client/   this machine's clients': remotes.json, window.json, settings.json
//   run/      what lives while processes do: hub.sock, hub.lock, locks/
//   log/      the logs
//
// Paths are joined with "/" (the hub and its clients that read them run on Unix-like systems).

export type Layout = {
  home: string;
  /** pi's agent directory (PI_CODING_AGENT_DIR). */
  agent: string;
  hub: string;
  /** The user's UI settings (themes, fonts, the network access). */
  hubSettings: string;
  /** The defaults new sessions take (variant, madness, model), written by agents under a lock. */
  defaults: string;
  workspace: string;
  /** A service's configuration when `--config` names none. */
  hubConfig: string;
  sessions: string;
  attachments: string;
  claude: string;
  client: string;
  remotes: string;
  window: string;
  run: string;
  socket: string;
  /** Who holds the hub on this machine (a window's or a service's pid). */
  hubLock: string;
  /** One agent per session: `<session id>.lock`. */
  locks: string;
  log: string;
};

/**
 * pi's directory of an absolute working directory's sessions under the sessions directory (its
 * session manager's getDefaultSessionDirPath): `--<cwd, "/" and ":" as "-">--`.
 */
export function cwdSessionsDir(sessions: string, cwd: string): string {
  return `${sessions}/--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function layoutOf(home: string): Layout {
  const at = (...parts: string[]): string => [home.replace(/\/+$/, ""), ...parts].join("/");
  return {
    home,
    agent: at("agent"),
    hub: at("hub"),
    hubSettings: at("hub", "settings.json"),
    defaults: at("hub", "defaults.json"),
    workspace: at("hub", "workspace.json"),
    hubConfig: at("hub", "config.json"),
    sessions: at("hub", "sessions"),
    attachments: at("hub", "attachments"),
    claude: at("hub", "claude"),
    client: at("client"),
    remotes: at("client", "remotes.json"),
    window: at("client", "window.json"),
    run: at("run"),
    socket: at("run", "hub.sock"),
    hubLock: at("run", "hub.lock"),
    locks: at("run", "locks"),
    log: at("log"),
  };
}
