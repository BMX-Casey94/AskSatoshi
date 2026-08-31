/**
 * Minimal pathname router — no third-party library. History API + popstate.
 * Production Express already falls back unknown GETs to index.html.
 */

import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';

export function normalisePath(path: string): string {
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path;
}

export function usePathname(): string {
  const [path, setPath] = useState(() => normalisePath(window.location.pathname));

  useEffect(() => {
    const sync = () => setPath(normalisePath(window.location.pathname));
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  return path;
}

export function navigate(to: string): void {
  const next = normalisePath(to);
  if (normalisePath(window.location.pathname) === next) return;
  window.history.pushState({}, '', next);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

interface LinkProps {
  href: string;
  className?: string;
  children: ReactNode;
  title?: string;
  'aria-label'?: string;
}

export function Link({ href, className, children, title, 'aria-label': ariaLabel }: LinkProps) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };

  return (
    <a href={href} className={className} title={title} aria-label={ariaLabel} onClick={onClick}>
      {children}
    </a>
  );
}
