/**
 * Links to the Mini App: the bot's main Mini App opened as a half-height
 * sheet in the chat the link was tapped in. `startapp` carries the workspace
 * (`w<chatId>`, a group's id is negative) and an optional section.
 */

export type AppSection = "new" | "model" | "thinking" | "sessions";

export function appLink(botUsername: string, chatId: number, section?: AppSection): string {
  return `https://t.me/${botUsername}?startapp=w${chatId}${section !== undefined ? `_${section}` : ""}&mode=compact`;
}

/** The workspace and section of a `startapp` value, or undefined when it is not one of ours. */
export function parseStartParam(value: string): { chatId: number; section?: AppSection } | undefined {
  const match = /^w(-?\d+)(?:_(new|model|thinking|sessions))?$/.exec(value);
  return match === null ? undefined : { chatId: Number(match[1]), section: match[2] as AppSection | undefined };
}
