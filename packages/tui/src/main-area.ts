// The main area: one component at a time (the transcript, a task's output, choosing a folder), in a
// scroll view. The slot hands its component's lines through untouched — a container would copy a
// long transcript at every frame. The scroll view tells the transcript when it moves (pi-tui
// redraws a scroll by itself without asking the components, and the transcript draws only what is
// in sight), and keeps the place in sight when lines above it change height.

import { ScrollView, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

export class MainSlot implements Component {
  private child: Component | undefined;

  show(component: Component): void {
    this.child = component;
  }

  get shown(): Component | undefined {
    return this.child;
  }

  invalidate(): void {
    this.child?.invalidate();
  }

  render(width: number): readonly string[] {
    return this.child?.render(width) ?? [];
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.child?.handleMouse?.(event);
  }
}

/** ScrollView's own fields this view reaches (pi-tui keeps them private). */
type ScrollState = { currentScrollTop: number };

export class MainScroll extends ScrollView {
  private readonly moved: () => void;

  constructor(slot: MainSlot, moved: () => void) {
    super(slot, { follow: "end", primary: true });
    this.moved = moved;
  }

  override scrollTo(scrollTop: number, options?: { disableFollow?: boolean }): void {
    super.scrollTo(scrollTop, options);
    this.moved();
  }

  override scrollBy(lines: number): number {
    const rest = super.scrollBy(lines);
    this.moved();
    return rest;
  }

  override scrollToStart(): void {
    super.scrollToStart();
    this.moved();
  }

  override scrollToEnd(): void {
    super.scrollToEnd();
    this.moved();
  }

  /**
   * Lines above the place in sight changed height while drawing: the place moves with them (the
   * layout clamps it to the new height right after). Following the end, the end stays.
   */
  keepPlace(lines: number): void {
    if (!this.isFollowingEnd) {
      (this as unknown as ScrollState).currentScrollTop += lines;
    } else {
      // the end is in sight whatever moved above
    }
  }
}
