import type { HelmetOptions } from 'helmet';

/**
 * BRC-100 desktop wallets (e.g. Metanet Client) expose their API over HTTP on
 * loopback, and @bsv/sdk's WalletClient('auto') probes these substrates:
 *   - http://localhost:3301  (HTTPWalletWire)
 *   - http://localhost:3321  (HTTPWalletJSON)
 *   - https://localhost:2121 (HTTPWalletJSON, secure)
 * A connect-src of 'self' alone makes desktop browsers refuse those fetches,
 * which surfaced as "No BRC-100 wallet is available". CSP host-source matching
 * is literal, so the 127.0.0.1 twins are listed alongside localhost.
 *
 * Injected wallets (BSV Browser's window.CWI) are pure in-page calls and need
 * no network access, which is why they were never affected.
 *
 * Security note: this only lets *this* origin initiate connections to the
 * user's own machine; the wallet still enforces its own per-originator
 * permission prompts, so the rest of the policy stays strict.
 */
export const WALLET_CONNECT_SOURCES = [
  'http://localhost:3301',
  'http://127.0.0.1:3301',
  'http://localhost:3321',
  'http://127.0.0.1:3321',
  'https://localhost:2121',
  'https://127.0.0.1:2121',
] as const;

/**
 * Content-Security-Policy: the SPA is self-contained (bundled JS/CSS, no CDN), so we
 * can run a strict policy. Images may be blob:/data: (local previews + inline assets);
 * the API is same-origin. No inline scripts or eval — React's production build needs neither.
 */
export const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"], // Vite injects critical CSS; React inline styles
  imgSrc: ["'self'", 'data:', 'blob:'],
  connectSrc: ["'self'", ...WALLET_CONNECT_SOURCES],
  mediaSrc: ["'self'"], // same-origin /api/tts/audio/*.mp3
  fontSrc: ["'self'", 'data:'],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
  // Must stay null: upgrade-insecure-requests would rewrite the http://localhost
  // wallet calls to https:// and break the wire/JSON substrates.
  upgradeInsecureRequests: null,
};

export const helmetOptions: HelmetOptions = {
  contentSecurityPolicy: { directives: cspDirectives },
  crossOriginEmbedderPolicy: false, // would break blob: image previews
};
