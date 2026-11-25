/**
 * Links to the Mini App: the bot's main Mini App opened as a half-height
 * sheet in the chat the link was tapped in. `startapp` carries the workspace
 * (`w<chatId>`, a group's id is negative) and an optional place: a section of
 * the main screen (here, sessions) or a screen (files, models).
 */

export type AppSection = "here" | "sessions" | "files" | "models";

export function appLink(botUsername: string, chatId: number, section?: AppSection): string {
  return `https://t.me/${botUsername}?startapp=w${chatId}${section !== undefined ? `_${section}` : ""}&mode=compact`;
}

/** The workspace and place of a `startapp` value, or undefined when it is not one of ours. */
export function parseStartParam(value: string): { chatId: number; section?: AppSection } | undefined {
  const match = /^w(-?\d+)(?:_(here|sessions|files|models))?$/.exec(value);
  return match === null ? undefined : { chatId: Number(match[1]), section: match[2] as AppSection | undefined };
}
