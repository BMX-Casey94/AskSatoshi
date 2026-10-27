/**
 * Layout and keyboard helpers for the answer-depth menu.
 * Coordinates are in one space: the caller converts visual-viewport
 * rectangles before calling, and the result is applied as fixed positioning.
 * The menu prefers to open below the trigger. It opens above when the
 * menu would not fit below and there is more room above. Either way the
 * box is clamped inside the viewport margin.
 */

import type { Depth } from '../types';

export const DEPTH_MENU_GAP = 6;
export const DEPTH_MENU_MARGIN = 8;
export const DEPTH_MENU_WIDTH = 288;

/**
 * Menu copy only. Descriptions stay one short line so the open list does not
 * need a second paragraph, and nothing here is repeated under the trigger.
 */
export const DEPTH_OPTIONS = [
  { value: 'default', label: 'Standard', description: 'A direct answer from the sources.' },
  { value: 'beginner', label: 'Beginner', description: 'Plain language, jargon unpacked.' },
  { value: 'developer', label: 'Developer', description: 'Notes for building on Bitcoin SV.' },
  { value: 'historian', label: 'Historian', description: 'The dated writings, as written.' },
] as const satisfies readonly { value: Depth; label: string; description: string }[];

export type DepthMenuPlacement = 'above' | 'below';
export type DepthMenuMoveKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

export interface ViewportBox {
  width: number;
  height: number;
  /** Offset of this viewport box. Omit when it is zero. */
  offsetLeft?: number;
  offsetTop?: number;
}

export interface TriggerBox {
  top: number;
  bottom: number;
  left: number;
}

export interface DepthMenuPosition {
  placement: DepthMenuPlacement;
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function placeDepthMenu(args: {
  trigger: TriggerBox;
  menuWidth: number;
  menuHeight: number;
  viewport: ViewportBox;
  gap?: number;
  margin?: number;
}): DepthMenuPosition {
  const gap = Math.max(0, finiteOr(args.gap ?? DEPTH_MENU_GAP, DEPTH_MENU_GAP));
  const margin = Math.max(0, finiteOr(args.margin ?? DEPTH_MENU_MARGIN, DEPTH_MENU_MARGIN));
  const offsetLeft = finiteOr(args.viewport.offsetLeft ?? 0, 0);
  const offsetTop = finiteOr(args.viewport.offsetTop ?? 0, 0);
  const viewWidth = Math.max(0, finiteOr(args.viewport.width, 0));
  const viewHeight = Math.max(0, finiteOr(args.viewport.height, 0));
  const viewLeft = offsetLeft;
  const viewTop = offsetTop;
  const viewRight = offsetLeft + viewWidth;
  const viewBottom = offsetTop + viewHeight;
  const menuWidth = Math.max(0, finiteOr(args.menuWidth, 0));
  const menuHeight = Math.max(0, finiteOr(args.menuHeight, 0));

  const maxWidth = viewWidth - margin * 2;
  const maxHeightBudget = viewHeight - margin * 2;
  if (maxWidth <= 0 || maxHeightBudget <= 0) {
    return {
      placement: 'below',
      top: viewTop,
      left: viewLeft,
      width: viewWidth,
      maxHeight: viewHeight,
    };
  }

  const width = Math.min(menuWidth, maxWidth);
  let left = finiteOr(args.trigger.left, viewLeft + margin);
  if (left + width > viewRight - margin) left = viewRight - margin - width;
  if (left < viewLeft + margin) left = viewLeft + margin;

  const triggerTop = finiteOr(args.trigger.top, viewTop);
  const triggerBottom = finiteOr(args.trigger.bottom, triggerTop);
  const spaceBelow = viewBottom - margin - (triggerBottom + gap);
  const spaceAbove = triggerTop - gap - (viewTop + margin);
  const placement: DepthMenuPlacement =
    spaceBelow >= menuHeight || spaceBelow >= spaceAbove ? 'below' : 'above';
  const available = Math.max(0, placement === 'below' ? spaceBelow : spaceAbove);
  const maxHeight = Math.min(menuHeight, available);
  const top =
    placement === 'below'
      ? triggerBottom + gap
      : Math.max(viewTop + margin, triggerTop - gap - maxHeight);

  return { placement, top, left, width, maxHeight };
}

/** Move the active option. Arrow keys stop at the ends. */
export function moveDepthIndex(current: number, length: number, key: DepthMenuMoveKey): number {
  if (length <= 0) return 0;
  const index = Number.isInteger(current) ? Math.min(Math.max(current, 0), length - 1) : 0;
  switch (key) {
    case 'ArrowDown':
      return Math.min(length - 1, index + 1);
    case 'ArrowUp':
      return Math.max(0, index - 1);
    case 'Home':
      return 0;
    case 'End':
      return length - 1;
  }
}

/**
 * Next label that starts with `query`. When `skipCurrent` is set, a repeated
 * first letter cycles to the following match and wraps.
 */
export function matchTypeahead(
  labels: readonly string[],
  fromIndex: number,
  query: string,
  opts?: { skipCurrent?: boolean },
): number {
  const count = labels.length;
  if (count === 0) return 0;
  const q = query.trim().toLowerCase();
  const index = Number.isInteger(fromIndex) ? Math.min(Math.max(fromIndex, 0), count - 1) : 0;
  if (!q) return index;
  const start = opts?.skipCurrent ? (index + 1) % count : index;
  for (let step = 0; step < count; step += 1) {
    const next = (start + step) % count;
    const label = labels[next];
    if (label && label.toLowerCase().startsWith(q)) return next;
  }
  return index;
}
