/**
 * What a workspace shows when an agent is attached to it: a header line
 * (directory · session · model, a link to the Mini App) and the last turns of
 * the session — each prompt quoted, then the final answer; no thinking, no
 * tool calls — packed into as few messages as the page limit allows.
 */

import type { Turn } from "../helper.ts";
import { PAGE_LIMIT, splitText } from "./render.ts";

export const HISTORY_TURNS = 5;
const PROMPT_LIMIT = 600;

export function historyPages(header: string, turns: readonly Turn[]): string[] {
  const parts = [header, ...turns.map(renderTurn)];
  const pages: string[] = [];
  let current = "";
  for (const part of parts.flatMap((p) => splitText(p, PAGE_LIMIT))) {
    if (current !== "" && current.length + part.length + 2 > PAGE_LIMIT) {
      pages.push(current);
      current = part;
    } else {
      current = current === "" ? part : `${current}\n\n${part}`;
    }
  }
  if (current !== "") pages.push(current);
  return pages;
}

function renderTurn(turn: Turn): string {
  const prompt = turn.prompt.length > PROMPT_LIMIT ? `${turn.prompt.slice(0, PROMPT_LIMIT - 1)}…` : turn.prompt;
  const quoted = prompt
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return turn.answer !== "" ? `${quoted}\n\n${turn.answer}` : quoted;
}
