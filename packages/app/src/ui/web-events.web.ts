// Browser details of a row (plan 10.1): its tooltip, the context menu on right click, closing with
// the middle button, reordering by dragging. React Native Web passes none of these through, so the
// row's DOM node gets the listeners itself.

import { useEffect, type RefObject } from "react";

export type RowEvents = {
  title?: string;
  onContextMenu?: (x: number, y: number) => void;
  onMiddleClick?: () => void;
  /** Reordering: this row's place, and what to do when another row is dropped on it. */
  drag?: { index: number; onDrop: (from: number) => void };
};

const DRAG_TYPE = "application/x-harness-row";

/**
 * A list's keyboard: ↑/↓ move the focus between its rows, Space and Enter press the focused row,
 * Esc hands the keyboard back to the message field. A field in the list (data-list-row) is a row
 * too: ↑/↓ leave it, every other key is its own.
 */
export function useListKeys(ref: RefObject<unknown>, onEscape: () => void = focusMessage): void {
  useEffect(() => {
    const node = ref.current as HTMLElement | null;
    if (node === null || typeof node.addEventListener !== "function") {
      return undefined;
    } else {
      const keydown = (event: KeyboardEvent): void => {
        const rows = [...node.querySelectorAll<HTMLElement>("[role=button], [data-list-row]")];
        const index = rows.indexOf(document.activeElement as HTMLElement);
        const field = rows[index]?.hasAttribute("data-list-row") === true;
        if (index < 0) {
          return; // the focus is not on a row of this list
        } else if (field && event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Escape") {
          return; // typing, the cursor's moves, Enter: the field's own
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          event.stopPropagation();
          rows[(index + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length]?.focus();
        } else if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          rows[index]?.click();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onEscape();
        } else {
          // a key of the page
        }
      };
      node.addEventListener("keydown", keydown);
      return () => node.removeEventListener("keydown", keydown);
    }
  }, [ref, onEscape]);
}

/**
 * A step's keys besides the list's (a login step): ← on a row goes back, typing on a row goes to the
 * step's field at once (the character lands in it).
 */
export function useStepKeys(ref: RefObject<unknown>, onBack: () => void): void {
  useEffect(() => {
    const node = ref.current as HTMLElement | null;
    if (node === null || typeof node.addEventListener !== "function") {
      return undefined;
    } else {
      const keydown = (event: KeyboardEvent): void => {
        const active = document.activeElement as HTMLElement | null;
        const inField = active?.hasAttribute("data-list-row") === true;
        if (inField || active === null || !node.contains(active)) {
          return; // the field's keys, or the focus is elsewhere
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          onBack();
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== " ") {
          node.querySelector<HTMLElement>("[data-list-row]")?.focus();
        } else {
          // the list's keys
        }
      };
      node.addEventListener("keydown", keydown);
      return () => node.removeEventListener("keydown", keydown);
    }
  }, [ref, onBack]);
}

/** The keyboard into a list (by its accessible name): on its selected row, else its first. */
export function focusList(label: string): boolean {
  const list = document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  const row = list?.querySelector<HTMLElement>("[role=button][aria-selected=true]") ?? list?.querySelector<HTMLElement>("[role=button]");
  if (row !== null && row !== undefined) {
    row.focus();
    return true;
  } else {
    return false;
  }
}

/** The keyboard back to the message field. */
export function focusMessage(): void {
  document.querySelector<HTMLElement>('[aria-label="Message"]')?.focus();
}

export function useRowEvents(ref: RefObject<unknown>, events: RowEvents): void {
  const { title, onContextMenu, onMiddleClick, drag } = events;
  useEffect(() => {
    const node = ref.current as HTMLElement | null;
    if (node === null || typeof node.addEventListener !== "function") {
      return undefined;
    } else {
      if (title !== undefined) {
        node.title = title;
      } else {
        node.removeAttribute("title");
      }
      const contextmenu = (event: MouseEvent): void => {
        if (onContextMenu !== undefined) {
          event.preventDefault();
          onContextMenu(event.clientX, event.clientY);
        } else {
          // the browser's own menu
        }
      };
      const auxclick = (event: MouseEvent): void => {
        if (event.button === 1 && onMiddleClick !== undefined) {
          event.preventDefault();
          onMiddleClick();
        } else {
          // another button
        }
      };
      const dragstart = (event: DragEvent): void => {
        event.dataTransfer?.setData(DRAG_TYPE, String(drag?.index ?? -1));
      };
      const dragover = (event: DragEvent): void => {
        if (event.dataTransfer?.types.includes(DRAG_TYPE) === true) {
          event.preventDefault();
        } else {
          // not a row
        }
      };
      const drop = (event: DragEvent): void => {
        const from = Number(event.dataTransfer?.getData(DRAG_TYPE) ?? "-1");
        if (drag !== undefined && from >= 0 && from !== drag.index) {
          event.preventDefault();
          drag.onDrop(from);
        } else {
          // dropped on itself, or not a row
        }
      };
      node.draggable = drag !== undefined;
      node.addEventListener("contextmenu", contextmenu);
      node.addEventListener("auxclick", auxclick);
      node.addEventListener("dragstart", dragstart);
      node.addEventListener("dragover", dragover);
      node.addEventListener("drop", drop);
      return () => {
        node.removeEventListener("contextmenu", contextmenu);
        node.removeEventListener("auxclick", auxclick);
        node.removeEventListener("dragstart", dragstart);
        node.removeEventListener("dragover", dragover);
        node.removeEventListener("drop", drop);
      };
    }
  }, [ref, title, onContextMenu, onMiddleClick, drag?.index, drag?.onDrop]);
}
