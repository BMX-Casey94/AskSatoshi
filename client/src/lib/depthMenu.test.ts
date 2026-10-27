import { describe, expect, it } from 'vitest';
import {
  DEPTH_OPTIONS,
  matchTypeahead,
  moveDepthIndex,
  placeDepthMenu,
  type DepthMenuPosition,
  type ViewportBox,
} from './depthMenu';

function expectInside(pos: DepthMenuPosition, viewport: ViewportBox, margin: number) {
  const viewLeft = viewport.offsetLeft ?? 0;
  const viewTop = viewport.offsetTop ?? 0;
  const viewRight = viewLeft + viewport.width;
  const viewBottom = viewTop + viewport.height;
  expect(pos.left).toBeGreaterThanOrEqual(viewLeft + margin);
  expect(pos.left + pos.width).toBeLessThanOrEqual(viewRight - margin + 0.001);
  expect(pos.top).toBeGreaterThanOrEqual(viewTop + margin);
  expect(pos.top + pos.maxHeight).toBeLessThanOrEqual(viewBottom - margin + 0.001);
  expect(pos.width).toBeGreaterThan(0);
  expect(pos.maxHeight).toBeGreaterThan(0);
}

describe('placeDepthMenu', () => {
  it('opens below when the menu fits, even if there is more room above', () => {
    const pos = placeDepthMenu({
      trigger: { top: 400, bottom: 430, left: 80 },
      menuWidth: 288,
      menuHeight: 200,
      viewport: { width: 800, height: 800 },
    });
    expect(pos.placement).toBe('below');
    expect(pos.top).toBe(436);
    expect(pos.left).toBe(80);
    expect(pos.width).toBe(288);
    expect(pos.maxHeight).toBe(200);
  });

  it('opens above a trigger sitting at the bottom of a phone viewport', () => {
    const viewport = { width: 390, height: 700 };
    const pos = placeDepthMenu({
      trigger: { top: 640, bottom: 668, left: 120 },
      menuWidth: 288,
      menuHeight: 220,
      viewport,
    });
    expect(pos.placement).toBe('above');
    expect(pos.top).toBe(414);
    expect(pos.maxHeight).toBe(220);
    expect(pos.top + pos.maxHeight).toBe(640 - 6);
    expect(pos.left).toBe(94);
    expectInside(pos, viewport, 8);
  });

  it('keeps a wide menu inside a narrow viewport', () => {
    const viewport = { width: 320, height: 640 };
    const pos = placeDepthMenu({
      trigger: { top: 200, bottom: 228, left: 40 },
      menuWidth: 288,
      menuHeight: 180,
      viewport,
    });
    expect(pos.placement).toBe('below');
    expect(pos.width).toBe(288);
    expect(pos.left).toBe(24);
    expect(pos.left + pos.width).toBe(312);
    expectInside(pos, viewport, 8);
  });

  it('shifts a menu that would start off the left edge', () => {
    const pos = placeDepthMenu({
      trigger: { top: 100, bottom: 128, left: 0 },
      menuWidth: 100,
      menuHeight: 80,
      viewport: { width: 400, height: 600 },
    });
    expect(pos.left).toBe(8);
    expect(pos.placement).toBe('below');
  });

  it('uses the larger side when neither side can show the whole menu', () => {
    const below = placeDepthMenu({
      trigger: { top: 80, bottom: 110, left: 20 },
      menuWidth: 200,
      menuHeight: 500,
      viewport: { width: 400, height: 500 },
    });
    expect(below.placement).toBe('below');
    expect(below.top).toBe(116);
    expect(below.maxHeight).toBe(376);

    const above = placeDepthMenu({
      trigger: { top: 400, bottom: 430, left: 20 },
      menuWidth: 200,
      menuHeight: 500,
      viewport: { width: 400, height: 500 },
    });
    expect(above.placement).toBe('above');
    expect(above.top).toBe(8);
    expect(above.maxHeight).toBe(386);
  });

  it('honours a visual viewport offset', () => {
    const viewport = { width: 300, height: 500, offsetLeft: 10, offsetTop: 20 };
    const pos = placeDepthMenu({
      trigger: { top: 120, bottom: 150, left: 40 },
      menuWidth: 200,
      menuHeight: 100,
      viewport,
    });
    expect(pos.placement).toBe('below');
    expect(pos.top).toBe(156);
    expectInside(pos, viewport, 8);
  });

  it('returns a finite box for a degenerate viewport or a non-finite size', () => {
    const tiny = placeDepthMenu({
      trigger: { top: 0, bottom: 0, left: 0 },
      menuWidth: 288,
      menuHeight: 200,
      viewport: { width: 10, height: 10 },
    });
    expect(tiny.width).toBe(10);
    expect(tiny.maxHeight).toBe(10);
    expect(Number.isFinite(tiny.top)).toBe(true);

    const bad = placeDepthMenu({
      trigger: { top: 40, bottom: 60, left: 10 },
      menuWidth: Number.NaN,
      menuHeight: Number.POSITIVE_INFINITY,
      viewport: { width: 400, height: 400 },
    });
    expect(bad.width).toBe(0);
    expect(Number.isFinite(bad.maxHeight)).toBe(true);
    expect(Number.isFinite(bad.top)).toBe(true);
    expect(Number.isFinite(bad.left)).toBe(true);
  });
});

describe('DEPTH_OPTIONS', () => {
  it('keeps each description to a single short line inside the menu', () => {
    expect(DEPTH_OPTIONS.map((option) => option.value)).toEqual([
      'default',
      'beginner',
      'developer',
      'historian',
    ]);
    expect(DEPTH_OPTIONS.map((option) => option.label)).toEqual([
      'Standard',
      'Beginner',
      'Developer',
      'Historian',
    ]);
    for (const option of DEPTH_OPTIONS) {
      expect(option.description.length).toBeGreaterThan(0);
      expect(option.description.length).toBeLessThanOrEqual(40);
      expect(option.description.includes('\n')).toBe(false);
    }
    const joined = DEPTH_OPTIONS.map((option) => option.description).join(' ');
    expect(joined).not.toContain('Tied to the dated writings and what they actually said');
  });
});

describe('moveDepthIndex', () => {
  it('moves within the list and stops at the ends', () => {
    expect(moveDepthIndex(0, 4, 'ArrowDown')).toBe(1);
    expect(moveDepthIndex(3, 4, 'ArrowDown')).toBe(3);
    expect(moveDepthIndex(2, 4, 'ArrowUp')).toBe(1);
    expect(moveDepthIndex(0, 4, 'ArrowUp')).toBe(0);
    expect(moveDepthIndex(2, 4, 'Home')).toBe(0);
    expect(moveDepthIndex(1, 4, 'End')).toBe(3);
  });

  it('treats an empty list or a bad index as the start', () => {
    expect(moveDepthIndex(2, 0, 'End')).toBe(0);
    expect(moveDepthIndex(1.5, 4, 'Home')).toBe(0);
    expect(moveDepthIndex(-3, 4, 'ArrowDown')).toBe(1);
  });
});

describe('matchTypeahead', () => {
  const labels = ['Standard', 'Beginner', 'Developer', 'Historian'];

  it('jumps to the option whose label starts with the query', () => {
    expect(matchTypeahead(labels, 0, 'd')).toBe(2);
    expect(matchTypeahead(labels, 0, 'DE')).toBe(2);
    expect(matchTypeahead(labels, 0, 'h')).toBe(3);
    expect(matchTypeahead(labels, 0, 'b')).toBe(1);
  });

  it('cycles when the same first letter is typed again', () => {
    const names = ['Alpha', 'Alpine', 'Beta'];
    expect(matchTypeahead(names, 0, 'a', { skipCurrent: true })).toBe(1);
    expect(matchTypeahead(names, 1, 'a', { skipCurrent: true })).toBe(0);
    expect(matchTypeahead(names, 1, 'al')).toBe(1);
  });

  it('stays put when nothing matches or the query is empty', () => {
    expect(matchTypeahead(labels, 2, 'zz')).toBe(2);
    expect(matchTypeahead(labels, 1, '  ')).toBe(1);
    expect(matchTypeahead([], 0, 'a')).toBe(0);
  });
});
