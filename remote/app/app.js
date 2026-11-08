// The Mini App: three screens over the gateway's API (app/server.ts) — the
// main screen (here, agents, workspaces, history), Files and Models. The last
// known state of the workspace is shown at once from localStorage (marked
// stale, actions disabled) and replaced by a fresh one; while the page is
// visible the state is polled every POLL_MS. Errors of the page go to the
// gateway's journal.

const POLL_MS = 2000;
const RETRY_MS = 1000;

document.addEventListener("alpine:init", () => {
  const tg = window.Telegram.WebApp;
  const start = /^w(-?\d+)(?:_(here|sessions|files|models))?$/.exec(tg.initDataUnsafe.start_param ?? "");
  const ws = start !== null ? Number(start[1]) : tg.initDataUnsafe.user?.id;
  const place = start?.[2];
  const cacheKey = `state:${ws}`;

  async function call(path, init = {}) {
    for (;;) {
      const response = await fetch(path, { ...init, headers: { ...(init.headers ?? {}), Authorization: `tma ${tg.initData}`, "Content-Type": "application/json" } });
      if (response.status === 503) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS)); // the gateway is starting
      } else {
        return response.json();
      }
    }
  }

  function report(message, stack) {
    call("/app/api/telemetry", { method: "POST", body: JSON.stringify({ message: String(message), stack: String(stack ?? ""), url: location.pathname }) }).catch(() => undefined);
  }
  window.addEventListener("error", (event) => report(event.message, event.error?.stack));
  window.addEventListener("unhandledrejection", (event) => report(event.reason?.message ?? event.reason, event.reason?.stack));

  window.Alpine.data("app", () => ({
    screen: "main",
    state: undefined,
    stale: true,
    busy: false,
    problem: "",
    sessions: undefined,
    models: {},
    levels: {},
    filter: "",
    dir: { path: "~", entries: [], truncated: false, loading: false },
    showHidden: false,
    folderName: "",
    settings: undefined,
    adding: "",

    init() {
      tg.ready();
      tg.expand();
      tg.BackButton.onClick(() => this.back());
      const cached = localStorage.getItem(cacheKey);
      if (cached !== null) this.show(JSON.parse(cached), true);
      this.refresh().then(() => {
        if (place === "files" || place === "models") {
          this.open(place);
        } else if (place !== undefined) {
          requestAnimationFrame(() => document.getElementById(place)?.scrollIntoView({ block: "start" }));
        }
      });
      this.loadSessions();
      setInterval(() => {
        if (document.visibilityState === "visible" && tg.isActive !== false && !this.busy && this.screen === "main") this.refresh();
      }, POLL_MS);
    },

    get here() {
      return this.state?.workspace.agent;
    },

    get others() {
      return (this.state?.agents ?? []).filter((a) => a.id !== this.here?.id);
    },

    get shownSessions() {
      const filter = this.filter.trim().toLowerCase();
      return (this.sessions ?? []).filter((s) => filter === "" || s.dir.toLowerCase().includes(filter) || s.title.toLowerCase().includes(filter));
    },

    get crumbs() {
      const parts = this.dir.path.split("/");
      return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") }));
    },

    /* screens */

    open(screen) {
      this.screen = screen;
      tg.BackButton.show();
      window.scrollTo(0, 0);
      if (screen === "files") this.browse(this.here?.dir ?? "~");
      if (screen === "models") this.loadSettings();
    },

    back() {
      this.screen = "main";
      tg.BackButton.hide();
      this.refresh();
    },

    /* main */

    show(state, stale) {
      this.state = state;
      this.stale = stale;
    },

    async refresh() {
      const reply = await call(`/app/api/state?ws=${ws}`);
      if (reply.ok) {
        this.problem = "";
        this.show(reply.state, false);
        localStorage.setItem(cacheKey, JSON.stringify(reply.state));
      } else {
        this.problem = reply.problem;
      }
    },

    async loadSessions() {
      const reply = await call("/app/api/sessions");
      this.sessions = reply.ok ? reply.sessions : [];
      if (!reply.ok) this.problem = reply.problem;
    },

    async loadModels(agentId) {
      if (this.models[agentId] !== undefined) return;
      const reply = await call(`/app/api/models?agent=${encodeURIComponent(agentId)}`);
      this.models[agentId] = reply.ok ? reply.list.map((m) => `${m.provider}/${m.id}`) : [];
    },

    async loadLevels(agentId) {
      if (this.levels[agentId] !== undefined) return;
      const reply = await call(`/app/api/thinking?agent=${encodeURIComponent(agentId)}`);
      this.levels[agentId] = reply.ok ? reply.list : [];
    },

    /** Runs an action; resolves true when it succeeded. */
    async act(action) {
      this.busy = true;
      try {
        const reply = await call(`/app/api/action?ws=${ws}`, { method: "POST", body: JSON.stringify(action) });
        if (reply.ok) {
          tg.HapticFeedback.notificationOccurred("success");
          this.show(reply.state, false);
          localStorage.setItem(cacheKey, JSON.stringify(reply.state));
          if (action.type === "resume" || action.type === "close" || action.type === "new") this.loadSessions();
          if (action.type === "model") delete this.levels[action.agentId];
          return true;
        } else {
          tg.HapticFeedback.notificationOccurred("error");
          tg.showAlert(reply.problem);
          return false;
        }
      } finally {
        this.busy = false;
      }
    },

    confirmThen(question, action) {
      tg.showConfirm(question, (ok) => {
        if (ok) this.act(action);
      });
    },

    statusText(agent) {
      const status = { idle: "idle", running: "running", waiting: "waiting for you", stopped: "stopped" }[agent.status] ?? agent.status;
      return [agent.model?.split("/").pop(), agent.thinking, status].filter((part) => part !== undefined && part !== null).join(" · ");
    },

    agentDir(agentId) {
      const agent = (this.state?.agents ?? []).find((a) => a.id === agentId);
      return agent !== undefined ? agent.dir : "empty";
    },

    ago(ms) {
      const minutes = Math.round((Date.now() - ms) / 60000);
      if (minutes < 60) return `${minutes}m`;
      if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
      return `${Math.round(minutes / 1440)}d`;
    },

    /* files */

    async browse(path) {
      this.dir = { ...this.dir, path, loading: true };
      const reply = await call(`/app/api/files?path=${encodeURIComponent(path)}`);
      if (reply.ok) {
        this.dir = { path: reply.path, entries: reply.entries, truncated: reply.truncated, loading: false };
      } else {
        this.dir = { ...this.dir, loading: false };
        tg.showAlert(reply.problem);
      }
    },

    async newFolder() {
      const name = this.folderName.trim();
      if (name !== "" && (await this.act({ type: "mkdir", path: this.dir.path, name }))) {
        this.folderName = "";
        await this.browse(`${this.dir.path}/${name}`);
      }
    },

    async download(path) {
      if (await this.act({ type: "download", path })) tg.showAlert("Sent to the chat.");
    },

    size(bytes) {
      if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
      if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
      return `${bytes} B`;
    },

    /* models */

    async loadSettings() {
      this.settings = undefined;
      const reply = await call("/app/api/settings/models");
      if (reply.ok) {
        this.settings = reply.settings;
      } else {
        tg.showAlert(reply.problem);
      }
    },

    levelsOf(favorite) {
      return this.settings.available.find((m) => m.provider === favorite.provider && m.id === favorite.id)?.levels ?? [];
    },

    isDefault(favorite) {
      return this.settings.default?.provider === favorite.provider && this.settings.default?.id === favorite.id;
    },

    setDefault(favorite) {
      this.settings.default = { provider: favorite.provider, id: favorite.id };
      this.saveSettings();
    },

    addFavorite() {
      const [provider, ...rest] = this.adding.split("/");
      this.settings.favorites.push({ provider, id: rest.join("/") });
      if (this.settings.default === null) this.settings.default = { provider, id: rest.join("/") };
      this.adding = "";
      this.saveSettings();
    },

    removeFavorite(favorite) {
      this.settings.favorites = this.settings.favorites.filter((f) => f !== favorite);
      this.saveSettings();
    },

    async saveSettings() {
      this.busy = true;
      try {
        const favorites = this.settings.favorites.map((f) => ({ provider: f.provider, id: f.id, ...(f.effort !== undefined ? { effort: f.effort } : {}) }));
        const reply = await call("/app/api/settings/models", { method: "POST", body: JSON.stringify({ favorites, default: this.settings.default }) });
        if (reply.ok) {
          tg.HapticFeedback.notificationOccurred("success");
          this.models = {};
        } else {
          tg.showAlert(reply.problem);
          this.loadSettings();
        }
      } finally {
        this.busy = false;
      }
    },
  }));
});
