/**
 * The Mini App's routes: the static files (assets.ts) and the JSON API.
 *
 *   GET  /app/api/state?ws=<chatId>      the workspace, the user's agents and workspaces, directories
 *   GET  /app/api/sessions               the user's sessions without an agent (50 most recent)
 *   GET  /app/api/models?agent=<id>      the models the agent may switch to (favorites first)
 *   GET  /app/api/thinking?agent=<id>    the agent's thinking levels
 *   GET  /app/api/files?path=<~/dir>     a directory of the user's home (Files)
 *   GET  /app/api/settings/models        favorites, their effort, the default model (Models)
 *   POST /app/api/settings/models        { favorites, default } → saved
 *   POST /app/api/action?ws=<chatId>     { type, ... } → { ok: true, state } | { ok: false, problem }
 *   POST /app/api/telemetry              { message, stack?, url? }: an error of the page
 *
 * Every API request carries `Authorization: tma <initData>`, from a
 * configured user, for a workspace of theirs (401/403 otherwise). Actions run
 * in the user's queue, like Telegram updates; everything an action changes in
 * the chats is posted by the workbench.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { UserConfig } from "../config.ts";
import type { Clock } from "../core/clock.ts";
import type { Favorite, Helper, ModelRef } from "../helper.ts";
import { readBody, type AppHandler } from "../server.ts";
import type { Telemetry } from "../telemetry.ts";
import type { Result, Workbench } from "../workbench.ts";
import type { Assets } from "./assets.ts";
import { verifyInitData } from "./auth.ts";

export type AppDeps = {
  workbench: Workbench;
  helper: Helper;
  assets: Assets;
  botToken: string;
  clock: Clock;
  t: Telemetry;
  /** Every API request (idle shutdown). */
  activity(): void;
};

const SESSIONS_SHOWN = 50;

type Action =
  | { type: "new"; dir: string }
  | { type: "resume"; sessionId: string }
  | { type: "move"; agentId: string; to: number }
  | { type: "detach" }
  | { type: "close"; agentId: string }
  | { type: "stop"; agentId: string }
  | { type: "model"; agentId: string; provider: string; id: string }
  | { type: "thinking"; agentId: string; level: string }
  | { type: "mkdir"; path: string; name: string }
  | { type: "download"; path: string };

export function createApp(deps: AppDeps): AppHandler {
  const wb = deps.workbench;

  function json(response: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": String(Buffer.byteLength(text)) });
    response.end(text);
  }

  function authenticate(request: IncomingMessage): UserConfig | { status: number; problem: string } {
    const header = String(request.headers.authorization ?? "");
    const verified = header.startsWith("tma ") ? verifyInitData(header.slice(4), deps.botToken, deps.clock.now()) : { problem: "no initData" };
    if ("problem" in verified) {
      return { status: 401, problem: verified.problem };
    } else {
      const user = wb.user(verified.userId);
      return user !== undefined ? user : { status: 403, problem: "not a configured user" };
    }
  }

  async function act(user: UserConfig, chatId: number, action: Action): Promise<Result> {
    switch (action.type) {
      case "new":
        return wb.newAgent(user, chatId, action.dir);
      case "resume":
        return wb.resume(user, chatId, action.sessionId);
      case "move":
        return wb.attach(user, action.to, action.agentId);
      case "detach":
        return wb.detach(user, chatId);
      case "close":
        return wb.close(user, action.agentId);
      case "stop":
        return wb.stopAgent(user, action.agentId);
      case "model":
        return wb.setModel(user, action.agentId, action.provider, action.id);
      case "thinking":
        return wb.setThinking(user, action.agentId, action.level);
      case "mkdir":
        return wb.makeFolder(user, action.path, action.name);
      case "download":
        return wb.download(user, chatId, action.path);
      default:
        return { ok: false, problem: `unknown action ${(action as { type?: unknown }).type as string}` };
    }
  }

  async function body<T>(request: IncomingMessage, response: ServerResponse): Promise<T | undefined> {
    const raw = await readBody(request, response);
    if (raw === undefined) {
      return undefined; // too large: answered already
    }
    try {
      return JSON.parse(raw.toString("utf8")) as T;
    } catch {
      json(response, 400, { ok: false, problem: "not JSON" });
      return undefined;
    }
  }

  async function api(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    deps.activity();
    const user = authenticate(request);
    if ("status" in user) {
      deps.t.warn("app.rejected", { status: user.status, message: user.problem, path: url.pathname });
      json(response, user.status, { ok: false, problem: user.problem });
      return;
    }
    const route = url.pathname.slice("/app/api/".length);
    const ws = Number(url.searchParams.get("ws"));
    const agentId = url.searchParams.get("agent") ?? "";
    const method = request.method ?? "GET";
    if (route === "state" && method === "GET") {
      const state = wb.state(user, ws);
      json(response, state !== undefined ? 200 : 403, state !== undefined ? { ok: true, state } : { ok: false, problem: "not your workspace" });
    } else if (route === "sessions" && method === "GET") {
      const sessions = await deps.helper.sessions(user);
      if (sessions.ok) {
        const active = new Set(wb.agents.ofUser(user.telegramId).map((a) => a.sessionId));
        const list = sessions.data
          .filter((s) => !active.has(s.id))
          .slice(0, SESSIONS_SHOWN)
          .map((s) => ({ id: s.id, dir: wb.displayDir(user, s.cwd), title: s.title, modified: s.modified }));
        json(response, 200, { ok: true, sessions: list });
      } else {
        json(response, 500, { ok: false, problem: sessions.problem });
      }
    } else if (route === "models" && method === "GET") {
      const agent = wb.agents.get(agentId);
      if (agent === undefined || agent.userId !== user.telegramId) {
        json(response, 404, { ok: false, problem: "this agent is gone" });
      } else {
        const list = await wb.serial(user.telegramId, () => agent.models());
        const settings = await wb.models(user);
        const favorites = settings.ok ? settings.data.favorites.map((f) => `${f.provider}/${f.id}`) : [];
        if ("problem" in list) {
          json(response, 500, { ok: false, problem: list.problem });
        } else {
          // the favorites when there are any (Models), otherwise every model pi offers
          const chosen = favorites.length > 0 ? list.filter((m) => favorites.includes(`${m.provider}/${m.id}`)) : list;
          json(response, 200, { ok: true, list: chosen });
        }
      }
    } else if (route === "thinking" && method === "GET") {
      const agent = wb.agents.get(agentId);
      if (agent === undefined || agent.userId !== user.telegramId) {
        json(response, 404, { ok: false, problem: "this agent is gone" });
      } else {
        const list = await wb.serial(user.telegramId, () => agent.thinkingLevels());
        json(response, "problem" in list ? 500 : 200, "problem" in list ? { ok: false, problem: list.problem } : { ok: true, list });
      }
    } else if (route === "files" && method === "GET") {
      const listed = await wb.listFiles(user, url.searchParams.get("path") ?? "~");
      json(response, listed.ok ? 200 : 409, listed.ok ? { ok: true, ...listed.data } : listed);
    } else if (route === "settings/models" && method === "GET") {
      const settings = await wb.models(user);
      json(response, settings.ok ? 200 : 500, settings.ok ? { ok: true, settings: settings.data } : settings);
    } else if (route === "settings/models" && method === "POST") {
      const wanted = await body<{ favorites: Favorite[]; default: ModelRef | null }>(request, response);
      if (wanted === undefined) return;
      const saved = await wb.serial(user.telegramId, () => wb.saveModels(user, wanted.favorites, wanted.default));
      json(response, saved.ok ? 200 : 409, saved);
    } else if (route === "action" && method === "POST") {
      const action = await body<Action>(request, response);
      if (action === undefined) return;
      if (!wb.ownsWorkspace(user, ws)) {
        json(response, 403, { ok: false, problem: "not your workspace" });
        return;
      }
      deps.t.info("app.action", { user: user.name, chat: ws, type: action.type });
      const result = await wb.serial(user.telegramId, () => act(user, ws, action));
      json(response, result.ok ? 200 : 409, result.ok ? { ok: true, state: wb.state(user, ws) } : result);
    } else if (route === "telemetry" && method === "POST") {
      const report = await body<{ message?: unknown; stack?: unknown; url?: unknown }>(request, response);
      if (report === undefined) return;
      deps.t.error("app.error", { user: user.name, message: String(report.message ?? "").slice(0, 1000), stack: String(report.stack ?? "").slice(0, 4000), url: String(report.url ?? "").slice(0, 300) });
      json(response, 200, { ok: true });
    } else {
      json(response, 404, { ok: false, problem: "no such route" });
    }
  }

  return (request, response, url) => {
    if (url.pathname.startsWith("/app/api/")) {
      api(request, response, url).catch((error: unknown) => {
        deps.t.error("app.failed", { path: url.pathname, message: error instanceof Error ? (error.stack ?? error.message) : String(error) });
        if (!response.headersSent) json(response, 500, { ok: false, problem: "internal error" });
      });
    } else if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
    } else if (!deps.assets.serve(request, response, url.pathname)) {
      response.writeHead(404).end();
    } else {
      // served
    }
  };
}
