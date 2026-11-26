// The app's gallery (`/gallery?fixture=<name>`): one shared fixture drawn by the app's own
// components, for the side-by-side gallery with the TUI (testkit/gallery). A tool for looking: the
// fixtures are the same data the TUI gallery draws.

import { View } from "react-native";
import { CLAUDE_TASK, INTERACTIONS, ITEMS, NODES, TABS } from "#testkit/fixtures/fixtures.ts";
import { ToolRow } from "./Transcript.tsx";
import { useTheme } from "../theme/theme.tsx";
import { InteractionBlock } from "./Interactions.tsx";
import { T } from "./primitives.tsx";
import { ItemsStrip, NodesStrip, TabsStrip } from "./Shell.tsx";

function exhibit(name: string) {
  const interaction = name.startsWith("interaction-") ? INTERACTIONS[name.slice("interaction-".length)] : undefined;
  if (interaction !== undefined) {
    return { width: 720, body: <InteractionBlock request={interaction} from={undefined} answer={() => undefined} /> };
  } else if (name === "strip-all-glyphs") {
    return {
      width: 154,
      body: (
        <View>
          <NodesStrip nodes={NODES} chosen="laptop" onChoose={() => undefined} onAdd={() => undefined} />
          <TabsStrip tabs={TABS} active={1} onGoto={() => undefined} onNew={() => undefined} />
          <ItemsStrip items={ITEMS} selected="t2" onSelect={() => undefined} />
        </View>
      ),
    };
  } else if (name === "claude-task-collapsed" || name === "claude-task-expanded") {
    return {
      width: 720,
      body: (
        <ToolRow
          call={{ type: "toolCall", id: "t0", name: "Task", arguments: CLAUDE_TASK.args }}
          result={{ role: "toolResult", toolCallId: "t0", toolName: "Task", isError: false, ...CLAUDE_TASK.result }}
          live={undefined}
          expanded={name === "claude-task-expanded"}
          onDownload={() => undefined}
        />
      ),
    };
  } else if (name === "strip-empty") {
    return {
      width: 154,
      body: (
        <View>
          <NodesStrip nodes={[{ name: "default", label: "inprocess", glyph: "" }]} chosen="default" onChoose={() => undefined} onAdd={() => undefined} />
          <TabsStrip tabs={[]} active={-1} placing onGoto={() => undefined} onNew={() => undefined} />
        </View>
      ),
    };
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
