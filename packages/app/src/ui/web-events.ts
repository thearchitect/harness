// On iOS and Android a row has no tooltip, right click or middle button: a long press opens the
// same menu (ListRow's onLongPress); reordering by touch comes with the native builds.

import type { RefObject } from "react";

export type RowEvents = {
  title?: string;
  onContextMenu?: (x: number, y: number) => void;
  onMiddleClick?: () => void;
  drag?: { index: number; onDrop: (from: number) => void };
};

export function useRowEvents(_ref: RefObject<unknown>, _events: RowEvents): void {
  // nothing to listen to
}
