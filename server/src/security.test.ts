import { describe, expect, it } from 'vitest';
import { cspDirectives, helmetOptions, WALLET_CONNECT_SOURCES } from './security.js';

// Regression guard for the desktop-Chrome "No BRC-100 wallet is available" bug:
// @bsv/sdk's WalletClient('auto') reaches desktop wallets (e.g. Metanet Client)
// over HTTP on loopback, so connect-src must allow those origins or the browser
// refuses the connection. BSV Browser uses the injected window.CWI substrate
// (pure in-page calls, no network), which is why only desktop browsers broke.
describe('CSP connect-src (BRC-100 wallet access)', () => {
  it.each([
    'http://localhost:3301', // HTTPWalletWire default
    'http://127.0.0.1:3301',
    'http://localhost:3321', // HTTPWalletJSON default
    'http://127.0.0.1:3321',
    'https://localhost:2121', // HTTPWalletJSON secure
    'https://127.0.0.1:2121',
  ])('allows wallet substrate %s', (origin) => {
    expect(cspDirectives.connectSrc).toContain(origin);
  });

  it('keeps same-origin API access', () => {
    expect(cspDirectives.connectSrc).toContain("'self'");
  });

  it('does not enable upgrade-insecure-requests (would rewrite http://localhost wallet calls to https:// and break them)', () => {
    expect(cspDirectives.upgradeInsecureRequests).toBeNull();
  });
});

describe('CSP strictness preserved', () => {
  it('keeps the rest of the policy intact', () => {
    expect(cspDirectives.defaultSrc).toEqual(["'self'"]);
    expect(cspDirectives.scriptSrc).toEqual(["'self'"]);
    expect(cspDirectives.objectSrc).toEqual(["'none'"]);
    expect(cspDirectives.frameAncestors).toEqual(["'none'"]);
    expect(cspDirectives.mediaSrc).toEqual(["'self'"]);
    expect(helmetOptions.crossOriginEmbedderPolicy).toBe(false);
  });

  it('feeds the directives to helmet unchanged', () => {
    expect(helmetOptions.contentSecurityPolicy).toEqual({ directives: cspDirectives });
  });

  it('lists every wallet substrate origin exactly once', () => {
    expect(WALLET_CONNECT_SOURCES).toHaveLength(6);
    expect(new Set(WALLET_CONNECT_SOURCES).size).toBe(WALLET_CONNECT_SOURCES.length);
  });
});
