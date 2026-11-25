// The scripted model of the test stand: a pi extension that registers pi-ai's faux provider as
// `scenario/scripted` and plays the turns of a scenario file. Agents of a stand load it through
// HARNESS_TEST_EXTENSION; the file is HARNESS_TEST_SCENARIO (JSON: an array of turns). Each request
// the model receives is appended to HARNESS_TEST_REQUESTS (JSONL), for assertions on what the model
// was told. A turn without a script left answers "(no scripted turn)" so a test fails visibly.
// HARNESS_TEST_MODELS (a JSON array of ids, read when the agent starts) adds models to the
// provider's catalog, for tests of model references.
//
// A turn belongs to an agent: `agent` is a subagent profile's name, or "main" (default) for a
// session's own agent. Each request plays the first turn of its agent's kind nobody played yet,
// across all agents of the stand (a turn is claimed once, through a directory next to the file), so a
// session and its subagents run side by side without racing for each other's turns.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall, type FauxContentBlock } from "@earendil-works/pi-ai";

export type ScriptedTurn = {
  /** "main" (default): a session's own agent; otherwise the subagent profile that plays it. */
  agent?: string;
  thinking?: string;
  text?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  /** Waits this long before answering (lets a test act while the turn streams). */
  delayMs?: number;
};

export const SCENARIO_PROVIDER = "scenario";
export const SCENARIO_MODEL = "scripted";

/** Which agent this process is: a subagent's profile (from its --subagent launch), or "main". */
function role(): string {
  const index = process.argv.indexOf("--subagent");
  const launch = index >= 0 ? process.argv[index + 1] : undefined;
  return launch !== undefined ? ((JSON.parse(launch) as { profile?: string }).profile ?? "main") : "main";
}

/** Claims turn `index` for this process; false when another agent played it. */
function claim(scenarioPath: string, index: number): boolean {
  const dir = `${scenarioPath}.played`;
  mkdirSync(dir, { recursive: true });
  try {
    mkdirSync(`${dir}/${index}`);
    return true;
  } catch {
    return false;
  }
}

export default function scenarioModel(pi: ExtensionAPI): void {
  const scenarioPath = process.env.HARNESS_TEST_SCENARIO;
  const requestsPath = process.env.HARNESS_TEST_REQUESTS;
  const me = role();
  // read at every request: a test adds turns while the agent runs
  const turns = (): ScriptedTurn[] => (scenarioPath !== undefined && scenarioPath !== "" ? (JSON.parse(readFileSync(scenarioPath, "utf8")) as ScriptedTurn[]) : []);
  const nextTurn = (): ScriptedTurn | undefined => {
    if (scenarioPath === undefined || scenarioPath === "") {
      return undefined;
    } else {
      const list = turns();
      for (let index = 0; index < list.length; index += 1) {
        const turn = list[index];
        if (turn !== undefined && (turn.agent ?? "main") === me && claim(scenarioPath, index)) {
          return turn;
        } else {
          // another agent's turn, or played already
        }
      }
      return undefined;
    }
  };

  const modelsPath = process.env.HARNESS_TEST_MODELS;
  const extra = modelsPath !== undefined && modelsPath !== "" && existsSync(modelsPath) ? (JSON.parse(readFileSync(modelsPath, "utf8")) as string[]) : [];
  const faux = fauxProvider({ provider: SCENARIO_PROVIDER, models: [{ id: SCENARIO_MODEL }, ...extra.map((id) => ({ id, reasoning: true }))] });
  faux.setResponses(
    Array.from({ length: 1000 }, () => async (context: unknown) => {
      if (requestsPath !== undefined && requestsPath !== "") {
        appendFileSync(requestsPath, `${JSON.stringify({ agent: me, context })}\n`);
      } else {
        // requests are not recorded
      }
      const turn = nextTurn();
      if (turn === undefined) {
        return fauxAssistantMessage("(no scripted turn)");
      } else {
        if (turn.delayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, turn.delayMs));
        } else {
          // answers at once
        }
        const blocks: FauxContentBlock[] = [
          ...(turn.thinking !== undefined ? [fauxThinking(turn.thinking)] : []),
          ...(turn.text !== undefined ? [fauxText(turn.text)] : []),
          ...(turn.toolCalls ?? []).map((call) => fauxToolCall(call.name, call.args as Parameters<typeof fauxToolCall>[1])),
        ];
        return fauxAssistantMessage(blocks, { stopReason: (turn.toolCalls ?? []).length > 0 ? "toolUse" : "stop" });
      }
    }),
  );
  pi.registerProvider(faux.provider);
}
