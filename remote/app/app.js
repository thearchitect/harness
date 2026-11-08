// The Mini App: one page over the gateway's API (app/server.ts). The last
// known state of the workspace is shown at once from localStorage (marked
// stale, actions disabled) and replaced by a fresh one; while the page is
// visible the state is polled every POLL_MS.

const POLL_MS = 2000;
const RETRY_MS = 1000;

document.addEventListener("alpine:init", () => {
  const tg = window.Telegram.WebApp;
  const start = /^w(-?\d+)(?:_(new|model|thinking|sessions))?$/.exec(tg.initDataUnsafe.start_param ?? "");
  const ws = start !== null ? Number(start[1]) : tg.initDataUnsafe.user?.id;
  const section = start?.[2];
  const cacheKey = `state:${ws}`;

  async function call(path, init = {}) {
    for (;;) {
      const response = await fetch(path, { ...init, headers: { ...(init.headers ?? {}), Authorization: `tma ${tg.initData}` } });
      if (response.status === 503) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS)); // the gateway is starting
      } else {
        return response.json();
      }
    }
  }

  window.Alpine.data("app", () => ({
    state: undefined,
    stale: true,
    busy: false,
    problem: "",
    sessions: undefined,
    models: {},
    levels: {},
    dir: "",
    filter: "",

    init() {
      tg.ready();
      tg.expand();
      const cached = localStorage.getItem(cacheKey);
      if (cached !== null) this.show(JSON.parse(cached), true);
      this.refresh().then(() => {
        if (section !== undefined) {
          const target = { new: "new", model: "model", thinking: "thinking", sessions: "sessions" }[section];
          requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ block: "start" }));
        }
      });
      this.loadSessions();
      setInterval(() => {
        if (document.visibilityState === "visible" && tg.isActive !== false && !this.busy) this.refresh();
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

    show(state, stale) {
      this.state = state;
      this.stale = stale;
      if (!state.dirs.includes(this.dir)) this.dir = state.dirs[0] ?? "";
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

    async act(action) {
      this.busy = true;
      try {
        const reply = await call(`/app/api/action?ws=${ws}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) });
        if (reply.ok) {
          tg.HapticFeedback.notificationOccurred("success");
          this.show(reply.state, false);
          localStorage.setItem(cacheKey, JSON.stringify(reply.state));
          if (action.type === "resume" || action.type === "close" || action.type === "new") this.loadSessions();
        } else {
          tg.HapticFeedback.notificationOccurred("error");
          tg.showAlert(reply.problem);
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
  }));
});
