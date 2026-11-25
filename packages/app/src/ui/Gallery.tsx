// The app's gallery (`/gallery?fixture=<name>`): one shared fixture drawn by the app's own
// components, for the side-by-side gallery with the TUI (testkit/gallery). A tool for looking: the
// fixtures are the same data the TUI gallery draws.

import { View } from "react-native";
import { INTERACTIONS, ITEMS, TABS } from "#testkit/fixtures/fixtures.ts";
import { useTheme } from "../theme/theme.tsx";
import { InteractionBlock } from "./Interactions.tsx";
import { T } from "./primitives.tsx";
import { ItemsStrip, TabsStrip } from "./Shell.tsx";

function exhibit(name: string) {
  const interaction = name.startsWith("interaction-") ? INTERACTIONS[name.slice("interaction-".length)] : undefined;
  if (interaction !== undefined) {
    return { width: 720, body: <InteractionBlock request={interaction} from={undefined} answer={() => undefined} /> };
  } else if (name === "tabs-all-glyphs") {
    return { width: 220, body: <TabsStrip tabs={TABS} active={1} onGoto={() => undefined} onNew={() => undefined} /> };
  } else if (name === "tabs-empty") {
    return { width: 220, body: <TabsStrip tabs={[]} active={0} onGoto={() => undefined} onNew={() => undefined} /> };
  } else if (name === "items-tasks-subagents") {
    return { width: 260, body: <ItemsStrip items={ITEMS} selected="t2" onSelect={() => undefined} /> };
  } else {
    return undefined;
  }
}

export function Gallery({ fixture }: { fixture: string }) {
  const theme = useTheme();
  const shown = exhibit(fixture);
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.pageBg, alignItems: "flex-start", padding: 8 }}>
      {shown !== undefined ? (
        <View accessibilityLabel="exhibit" style={{ width: shown.width, backgroundColor: theme.colors.pageBg }}>
          {shown.body}
        </View>
      ) : (
        <T color="error">{`no fixture ${fixture}`}</T>
      )}
    </View>
  );
}
