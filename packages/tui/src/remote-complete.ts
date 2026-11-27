// Completion of `@file` mentions for a session on another machine: the paths come from its hub
// (harness_complete runs in the session's agent, in its directory); `/commands` are completed as
// pi's provider does. A session on this machine keeps pi's own provider (fd, fuzzy).

import { CombinedAutocompleteProvider, type AutocompleteItem, type AutocompleteProvider, type AutocompleteSuggestions, type SlashCommand } from "@earendil-works/pi-tui";

export type CompletePaths = (prefix: string) => Promise<string[]>;

const MENTION = /(?:^|\s)@(\S*)$/;

export class RemoteAutocompleteProvider implements AutocompleteProvider {
  readonly triggerCharacters = ["@", "/"];
  private readonly commands: CombinedAutocompleteProvider;
  private readonly paths: CompletePaths;

  constructor(commands: (SlashCommand | AutocompleteItem)[], paths: CompletePaths) {
    // its own file completion would read this machine: it is only asked for commands
    this.commands = new CombinedAutocompleteProvider(commands, "/nonexistent", null);
    this.paths = paths;
  }

  async getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal; force?: boolean }): Promise<AutocompleteSuggestions | null> {
    const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
    const mention = MENTION.exec(before);
    if (mention !== null) {
      const typed = mention[1] ?? "";
      const found = await this.paths(typed);
      return options.signal.aborted || found.length === 0 ? null : { prefix: `@${typed}`, items: found.map((path) => ({ value: `@${path}`, label: path })) };
    } else if (before.trimStart().startsWith("/") && cursorLine === 0) {
      return this.commands.getSuggestions(lines, cursorLine, cursorCol, options);
    } else {
      return null; // paths outside mentions are not completed for another machine
    }
  }

  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string): { lines: string[]; cursorLine: number; cursorCol: number } {
    if (prefix.startsWith("@")) {
      const line = lines[cursorLine] ?? "";
      // a directory stays open for its entries; a file ends the mention
      const inserted = item.value.endsWith("/") ? item.value : `${item.value} `;
      const start = cursorCol - prefix.length;
      const next = [...lines];
      next[cursorLine] = line.slice(0, start) + inserted + line.slice(cursorCol);
      return { lines: next, cursorLine, cursorCol: start + inserted.length };
    } else {
      return this.commands.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    }
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return MENTION.test((lines[cursorLine] ?? "").slice(0, cursorCol));
  }
}
