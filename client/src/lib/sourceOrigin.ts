/**
 * Map a citation URL to a short, human-readable origin label for the panel's
 * "Open original" row — e.g. Substack, Medium, Nakamoto Institute. Detection is
 * host-suffix based so any subdomain of a known platform resolves correctly
 * (singulargrit.substack.com → Substack). Unknown hosts fall back to a
 * title-cased second-level domain rather than staying silent.
 */

/** Longest-match platform suffixes. Order within equal length is irrelevant. */
const PLATFORM_SUFFIXES: ReadonlyArray<readonly [string, string]> = [
  ['nakamotoinstitute.org', 'Nakamoto Institute'],
  ['bitcointalk.org', 'Bitcointalk'],
  ['substack.com', 'Substack'],
  ['medium.com', 'Medium'],
  ['github.com', 'GitHub'],
  ['github.io', 'GitHub'],
  ['bitcoin.org', 'Bitcoin.org'],
];

/** Common multi-part public suffixes so the fallback doesn't pick "co" from co.uk. */
const MULTI_TLDS = new Set(['co.uk', 'org.uk', 'ac.uk', 'com.au', 'net.au', 'co.jp', 'co.nz']);

function titleCase(label: string): string {
  if (!label) return label;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Return a short origin label for `url`, or null when the URL is unparseable. */
export function sourceHostLabel(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;

  for (const [suffix, label] of PLATFORM_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return label;
  }

  const parts = host.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  const base =
    parts.length >= 3 && MULTI_TLDS.has(lastTwo)
      ? parts[parts.length - 3]
      : parts[parts.length - 2];
  if (!base || base.length < 2) return null;
  return titleCase(base);
}
