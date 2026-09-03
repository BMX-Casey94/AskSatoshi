import { describe, expect, it } from 'vitest';
import {
  TtsCreditExhaustedError,
  TtsSynthError,
  createResembleClient,
} from './resemble.js';

const VOICE = 'voice-uuid';
const KEY = 'rk_test';

function synthOk(audio: string, duration: number, issues: unknown[] = []) {
  return new Response(JSON.stringify({ success: true, audio_content: audio, duration, issues }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createResembleClient.synthesize', () => {
  it('chunks long text, decodes each audio_content, concatenates buffers and sums duration', async () => {
    const bodies: unknown[] = [];
    const fetchFn: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const n = bodies.length;
      return synthOk(Buffer.from(`part${n}`).toString('base64'), n === 1 ? 1.25 : 0.75);
    };
    const client = createResembleClient({
      apiKey: KEY,
      voiceUuid: VOICE,
      projectUuid: 'proj-1',
      fetchFn,
    });
    const long = `${'Sentence one is here. '.repeat(130)}The end.`;
    expect(long.length).toBeGreaterThan(2_400);
    const result = await client.synthesize(long);
    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) {
      expect(body).toMatchObject({
        voice_uuid: VOICE,
        project_uuid: 'proj-1',
        output_format: 'mp3',
        sample_rate: 22050,
      });
      expect(String((body as { data: string }).data).length).toBeLessThanOrEqual(2_400);
    }
    const parts = bodies.map((_, i) => Buffer.from(`part${i + 1}`));
    expect(result.audio).toEqual(Buffer.concat(parts));
    expect(result.durationSeconds).toBeCloseTo(1.25 + 0.75 * (bodies.length - 1));
  });

  it('throws TtsCreditExhaustedError on HTTP 402', async () => {
    const fetchFn = async () => new Response('no credits', { status: 402 });
    const client = createResembleClient({ apiKey: KEY, voiceUuid: VOICE, fetchFn });
    await expect(client.synthesize('Hello.')).rejects.toBeInstanceOf(TtsCreditExhaustedError);
  });

  it('throws TtsSynthError on non-402 failures and success:false, including status and issues', async () => {
    const failing = createResembleClient({
      apiKey: KEY,
      voiceUuid: VOICE,
      fetchFn: async () => new Response('boom', { status: 500 }),
    });
    await expect(failing.synthesize('Hello.')).rejects.toMatchObject({
      name: 'TtsSynthError',
      status: 500,
    });

    const rejected = createResembleClient({
      apiKey: KEY,
      voiceUuid: VOICE,
      fetchFn: async () =>
        new Response(JSON.stringify({ success: false, issues: ['bad voice'] }), { status: 200 }),
    });
    await expect(rejected.synthesize('Hello.')).rejects.toBeInstanceOf(TtsSynthError);
    await expect(rejected.synthesize('Hello.')).rejects.toMatchObject({ issues: ['bad voice'] });
  });
});

describe('createResembleClient wallet', () => {
  it('returns balance dollars from the billing wallet endpoint', async () => {
    const fetchFn: typeof fetch = async (input) => {
      expect(String(input)).toBe('https://app.resemble.ai/billing/api/v1/wallet');
      return new Response(JSON.stringify({ wallet: { balance_dollars: 9.92, low_balance: false } }), {
        status: 200,
      });
    };
    const client = createResembleClient({ apiKey: KEY, voiceUuid: VOICE, fetchFn });
    await expect(client.getWalletBalanceDollars()).resolves.toBe(9.92);
    await expect(client.getWallet()).resolves.toEqual({ balanceDollars: 9.92, lowBalance: false });
  });

  it('returns null on any wallet failure', async () => {
    const client = createResembleClient({
      apiKey: KEY,
      voiceUuid: VOICE,
      fetchFn: async () => new Response('nope', { status: 401 }),
    });
    await expect(client.getWalletBalanceDollars()).resolves.toBeNull();
    await expect(client.getWallet()).resolves.toBeNull();
  });
});
