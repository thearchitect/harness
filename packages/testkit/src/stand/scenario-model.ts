// The scripted model of the test stand: a pi extension that registers pi-ai's faux provider as
// `scenario/scripted` and plays the turns of a scenario file. Agents of a stand load it through
// HARNESS_TEST_EXTENSION; the file is HARNESS_TEST_SCENARIO (JSON: an array of turns). Each request
// the model receives is appended to HARNESS_TEST_REQUESTS (JSONL), for assertions on what the model
// was told. A turn without a script left answers "(no scripted turn)" so a test fails visibly.
// HARNESS_TEST_MODELS (a JSON array of ids, read when the agent starts) adds models to the
// provider's catalog, for tests of model references.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall, type FauxContentBlock } from "@earendil-works/pi-ai";

export type ScriptedTurn = {
  thinking?: string;
  text?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  /** Waits this long before answering (lets a test act while the turn streams). */
  delayMs?: number;
};

export const SCENARIO_PROVIDER = "scenario";
export const SCENARIO_MODEL = "scripted";

export default function scenarioModel(pi: ExtensionAPI): void {
  const scenarioPath = process.env.HARNESS_TEST_SCENARIO;
  const requestsPath = process.env.HARNESS_TEST_REQUESTS;
  // read at every request: a test adds turns while the agent runs
  const turns = (): ScriptedTurn[] => (scenarioPath !== undefined && scenarioPath !== "" ? (JSON.parse(readFileSync(scenarioPath, "utf8")) as ScriptedTurn[]) : []);
  let next = 0;

  const modelsPath = process.env.HARNESS_TEST_MODELS;
  const extra = modelsPath !== undefined && modelsPath !== "" && existsSync(modelsPath) ? (JSON.parse(readFileSync(modelsPath, "utf8")) as string[]) : [];
  const faux = fauxProvider({ provider: SCENARIO_PROVIDER, models: [{ id: SCENARIO_MODEL }, ...extra.map((id) => ({ id, reasoning: true }))] });
  faux.setResponses(
    Array.from({ length: 1000 }, () => async (context: unknown) => {
      if (requestsPath !== undefined && requestsPath !== "") {
        appendFileSync(requestsPath, `${JSON.stringify(context)}\n`);
      } else {
        // requests are not recorded
      }
      const turn = turns()[next];
      next += 1;
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
