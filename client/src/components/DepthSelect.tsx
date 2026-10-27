/**
 * Answer-depth chooser. The trigger is a compact pill (current label and chevron).
 * The menu is portaled and opens upward when the composer sits at the bottom.
 * Option descriptions live in the menu only.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  DEPTH_MENU_GAP,
  DEPTH_MENU_MARGIN,
  DEPTH_MENU_WIDTH,
  DEPTH_OPTIONS as OPTIONS,
  matchTypeahead,
  moveDepthIndex,
  placeDepthMenu,
  type DepthMenuMoveKey,
  type DepthMenuPosition,
  type TriggerBox,
  type ViewportBox,
} from '../lib/depthMenu';
import type { Depth } from '../types';
import { CheckIcon, ChevronDownIcon } from './icons';

const LABELS = OPTIONS.map((option) => option.label);
const TYPEAHEAD_RESET_MS = 500;
const CLOSE_MS = 140;

interface Props {
  value: Depth;
  onChange: (depth: Depth) => void;
}

type Phase = 'closed' | 'open' | 'closing';

function optionDomId(listboxId: string, depth: Depth): string {
  return `${listboxId}-${depth}`;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function readAnchor(trigger: HTMLElement): { trigger: TriggerBox; viewport: ViewportBox } {
  const rect = trigger.getBoundingClientRect();
  const visual = window.visualViewport;
  const offsetLeft = visual?.offsetLeft ?? 0;
  const offsetTop = visual?.offsetTop ?? 0;
  return {
    trigger: {
      top: rect.top + offsetTop,
      bottom: rect.bottom + offsetTop,
      left: rect.left + offsetLeft,
    },
    viewport: {
      width: visual?.width ?? window.innerWidth,
      height: visual?.height ?? window.innerHeight,
      offsetLeft,
      offsetTop,
    },
  };
}

export function DepthSelect({ value, onChange }: Props) {
  const triggerId = useId();
  const listboxId = useId();

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const ignoreClickRef = useRef(false);
  const typeaheadRef = useRef({ query: '', at: 0 });

  const [phase, setPhase] = useState<Phase>('closed');
  const [activeIndex, setActiveIndex] = useState(0);
  const [box, setBox] = useState<DepthMenuPosition | null>(null);

  const current = OPTIONS.find((option) => option.value === value) ?? OPTIONS[0];
  const selectedIndex = Math.max(
    0,
    OPTIONS.findIndex((option) => option.value === value),
  );
  const active = OPTIONS[activeIndex] ?? current;
  const activeOptionId = active ? optionDomId(listboxId, active.value) : undefined;

  const closeMenu = (restoreFocus: boolean) => {
    const reduced = prefersReducedMotion();
    setPhase((state) => {
      if (state !== 'open') return state;
      return reduced ? 'closed' : 'closing';
    });
    if (restoreFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  };

  const closeMenuRef = useRef(closeMenu);
  closeMenuRef.current = closeMenu;

  const openMenu = () => {
    setActiveIndex(selectedIndex);
    typeaheadRef.current = { query: '', at: 0 };
    setPhase('open');
  };

  const commitIndex = (index: number) => {
    const option = OPTIONS[index];
    if (option && option.value !== value) onChange(option.value);
    closeMenu(true);
  };

  useEffect(() => {
    if (phase !== 'closing') return;
    const timer = window.setTimeout(() => {
      setPhase((state) => (state === 'closing' ? 'closed' : state));
    }, CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'open') return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenuRef.current(true);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      event.preventDefault();
      closeMenuRef.current(true);
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [phase]);

  useLayoutEffect(() => {
    if (phase === 'closed') return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;

    const place = () => {
      const anchor = readAnchor(trigger);
      const provisional = Math.min(
        DEPTH_MENU_WIDTH,
        Math.max(0, anchor.viewport.width - DEPTH_MENU_MARGIN * 2),
      );
      menu.style.width = `${provisional}px`;
      const border = Math.max(0, menu.offsetHeight - menu.clientHeight);
      const menuHeight = menu.scrollHeight + border;
      const pos = placeDepthMenu({
        trigger: anchor.trigger,
        menuWidth: provisional,
        menuHeight,
        viewport: anchor.viewport,
        gap: DEPTH_MENU_GAP,
        margin: DEPTH_MENU_MARGIN,
      });
      setBox((prev) => {
        if (
          prev &&
          prev.placement === pos.placement &&
          prev.top === pos.top &&
          prev.left === pos.left &&
          prev.width === pos.width &&
          prev.maxHeight === pos.maxHeight
        ) {
          return prev;
        }
        return pos;
      });
    };

    place();
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && menu.contains(target)) return;
      place();
    };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    const visual = window.visualViewport;
    visual?.addEventListener('resize', place);
    visual?.addEventListener('scroll', place);
    const observer = new ResizeObserver(place);
    observer.observe(trigger);

    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
      visual?.removeEventListener('resize', place);
      visual?.removeEventListener('scroll', place);
      observer.disconnect();
    };
  }, [phase]);

  useEffect(() => {
    if (phase !== 'open' || !box || !active) return;
    const menu = menuRef.current;
    const option = document.getElementById(optionDomId(listboxId, active.value));
    if (!menu || !option) return;
    const top = option.offsetTop;
    const bottom = top + option.offsetHeight;
    if (top < menu.scrollTop) menu.scrollTop = top;
    else if (bottom > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = bottom - menu.clientHeight;
    }
  }, [phase, box, active, listboxId]);

  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const key = event.key;
    if (phase !== 'open') {
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') {
        event.preventDefault();
        ignoreClickRef.current = key === 'Enter' || key === ' ';
        openMenu();
      }
      return;
    }

    if (key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    if (key === 'Tab') {
      closeMenu(false);
      return;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
      event.preventDefault();
      setActiveIndex((index) => moveDepthIndex(index, OPTIONS.length, key as DepthMenuMoveKey));
      return;
    }
    if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      ignoreClickRef.current = true;
      commitIndex(activeIndex);
      return;
    }
    if (key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      const now = Date.now();
      const previous = typeaheadRef.current;
      const fresh = now - previous.at > TYPEAHEAD_RESET_MS;
      const query = fresh ? key : `${previous.query}${key}`;
      typeaheadRef.current = { query, at: now };
      setActiveIndex((index) => matchTypeahead(LABELS, index, query, { skipCurrent: fresh }));
    }
  };

  const menu =
    phase !== 'closed' && typeof document !== 'undefined'
      ? createPortal(
          <ul
            ref={menuRef}
            id={listboxId}
            className="depth-popover"
            role="listbox"
            aria-label="Answer depth"
            aria-hidden={phase !== 'open'}
            inert={phase !== 'open'}
            tabIndex={-1}
            data-ready={box ? 'true' : 'false'}
            data-placement={box?.placement ?? 'below'}
            data-closing={phase === 'closing' ? 'true' : 'false'}
            style={
              box
                ? { top: box.top, left: box.left, width: box.width, maxHeight: box.maxHeight }
                : undefined
            }
          >
            {OPTIONS.map((option, index) => {
              const selected = option.value === value;
              return (
                <li
                  key={option.value}
                  id={optionDomId(listboxId, option.value)}
                  role="option"
                  aria-selected={selected}
                  data-active={index === activeIndex ? 'true' : 'false'}
                  className="depth-option"
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => commitIndex(index)}
                >
                  <span className="depth-option-copy">
                    <span className="depth-option-label">{option.label}</span>
                    <span className="depth-option-desc">{option.description}</span>
                  </span>
                  {selected ? (
                    <CheckIcon size={16} className="depth-option-tick" />
                  ) : (
                    <span className="depth-option-tick depth-option-tick--empty" aria-hidden="true" />
                  )}
                </li>
              );
            })}
          </ul>,
          document.body,
        )
      : null;

  return (
    <div className="depth" ref={rootRef}>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className="depth-trigger"
        aria-label="Answer depth"
        aria-haspopup="listbox"
        aria-expanded={phase === 'open'}
        aria-controls={phase === 'closed' ? undefined : listboxId}
        aria-activedescendant={phase === 'open' ? activeOptionId : undefined}
        onClick={() => {
          if (ignoreClickRef.current) {
            ignoreClickRef.current = false;
            return;
          }
          if (phase === 'open') closeMenu(false);
          else openMenu();
        }}
        onKeyDown={onTriggerKeyDown}
        onKeyUp={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          window.setTimeout(() => {
            ignoreClickRef.current = false;
          }, 0);
        }}
      >
        <span className="depth-trigger-label">{current.label}</span>
        <ChevronDownIcon
          size={14}
          className={`depth-chevron${phase === 'open' ? ' depth-chevron--open' : ''}`}
        />
      </button>
      {menu}
    </div>
  );
}
