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
