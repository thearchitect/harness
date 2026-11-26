// On iOS and Android a row has no tooltip, right click or middle button: a long press opens the
// same menu (ListRow's onLongPress); reordering by touch comes with the native builds.

import type { RefObject } from "react";

export type RowEvents = {
  title?: string;
  onContextMenu?: (x: number, y: number) => void;
  onMiddleClick?: () => void;
  drag?: { index: number; onDrop: (from: number) => void };
};

/** Touch moves through lists itself; hardware keyboards come with the native builds. */
export function useListKeys(_ref: RefObject<unknown>, _onEscape?: () => void): void {
  // nothing to listen to
}

/** A step's ← and typing on its rows: phones have the back button and the field itself. */
export function useStepKeys(_ref: RefObject<unknown>, _onBack: () => void): void {
  // nothing to listen to
}

export function focusList(_label: string): boolean {
  return false;
}

export function focusMessage(): void {
  // the field takes the focus when touched
}

export function useRowEvents(_ref: RefObject<unknown>, _events: RowEvents): void {
  // nothing to listen to
}
