// The app's own rows of /settings (plan 6.1): the fonts of its two zones and, on web, browser
// notifications. They live in the user's settings on the home node, like everything else, so every
// app of the user draws the same.

import type { ClientModel } from "#client/model/client-model.ts";
import type { UiSetting, Workbench } from "#client/workbench/workbench.ts";
import { FONT_FAMILIES, TERMINUS_SIZES, zoneOf, DEFAULT_THEME, type FontFamily } from "./theme/theme.tsx";

const SIZES = [11, 12, 13, 14, 15, 16, 18, 20];

const ZONES = [
  { key: "ui.font.chat", label: "chat font", description: "transcript and editor", fallback: DEFAULT_THEME.chat },
  { key: "ui.font.chrome", label: "interface font", description: "strips, lists, footer, dialogs", fallback: DEFAULT_THEME.chrome },
] as const;

export function appSettings(client: ClientModel, workbench: Workbench, notifications: { supported: boolean; request(): Promise<boolean> }): UiSetting[] {
  const fonts: UiSetting[] = ZONES.map((zone) => {
    const current = zoneOf(client.settings[zone.key], zone.fallback);
    return {
      value: zone.key,
      label: `${zone.label}: ${current.family} ${current.size}`,
      description: zone.description,
      choose: () =>
        workbench.openPicker({
          id: `${zone.key}.family`,
          title: zone.label,
          items: (Object.keys(FONT_FAMILIES) as FontFamily[]).map((family) => ({ value: family, label: family })),
          choose: (family) =>
            workbench.openPicker({
              id: `${zone.key}.size`,
              title: `${zone.label}: ${family}`,
              items: (family === "terminus" ? TERMINUS_SIZES : SIZES).map((size) => ({ value: String(size), label: `${size}px` })),
              choose: (size) => client.setting(zone.key, { family, size: Number(size) }),
            }),
        }),
    };
  });
  const enabled = client.settings["ui.web.notifications"] === true;
  const notify: UiSetting[] = notifications.supported
    ? [
        {
          value: "notifications",
          label: `notifications: ${enabled ? "on" : "off"}`,
          description: "when a session waits for you and this window is not in front",
          choose: async () => {
            if (enabled) {
              await client.setting("ui.web.notifications", false);
            } else if (await notifications.request()) {
              await client.setting("ui.web.notifications", true);
            } else {
              workbench.notify("warning", "the browser does not allow notifications for this page");
            }
          },
        },
      ]
    : [];
  return [...fonts, ...notify];
}
