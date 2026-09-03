/**
 * Resemble AI client. Synthesis is chunked to stay under CHUNK_MAX_CHARS; MP3 frames
 * concatenate safely so we stitch chunk buffers rather than re-encode.
 */

import { chunkText } from './chunk.js';
import type { WalletSnapshot } from './state.js';

const SYNTH_URL = 'https://f.cluster.resemble.ai/synthesize';
const WALLET_URL = 'https://app.resemble.ai/billing/api/v1/wallet';
const CHUNK_TIMEOUT_MS = 60_000;

export class TtsCreditExhaustedError extends Error {
  readonly status = 402;
  constructor(message = 'Resemble credits exhausted') {
    super(message);
    this.name = 'TtsCreditExhaustedError';
  }
}

export class TtsSynthError extends Error {
  readonly status?: number;
  readonly issues?: unknown;
  constructor(message: string, opts: { status?: number; issues?: unknown } = {}) {
    super(message);
    this.name = 'TtsSynthError';
    this.status = opts.status;
    this.issues = opts.issues;
  }
}

export interface ResembleClient {
  synthesize(text: string): Promise<{ audio: Buffer; durationSeconds: number }>;
  getWalletBalanceDollars(): Promise<number | null>;
  getWallet(): Promise<WalletSnapshot | null>;
}

export interface ResembleClientOptions {
  apiKey: string;
  voiceUuid: string;
  projectUuid?: string;
  fetchFn?: typeof fetch;
}

interface SynthJson {
  success?: boolean;
  audio_content?: string;
  duration?: number;
  issues?: unknown;
}

interface WalletJson {
  wallet?: { balance_dollars?: number; low_balance?: boolean };
}

export function createResembleClient(opts: ResembleClientOptions): ResembleClient {
  const fetchFn = opts.fetchFn ?? fetch;
  const headers = {
    Authorization: `Bearer ${opts.apiKey}`,
    'Content-Type': 'application/json',
  };

  const synthesizeChunk = async (data: string): Promise<{ audio: Buffer; durationSeconds: number }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHUNK_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchFn(SYNTH_URL, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          voice_uuid: opts.voiceUuid,
          data,
          ...(opts.projectUuid ? { project_uuid: opts.projectUuid } : {}),
          output_format: 'mp3',
          sample_rate: 22050,
        }),
      });
    } catch (err) {
      throw new TtsSynthError(err instanceof Error ? err.message : 'synthesis request failed');
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 402) throw new TtsCreditExhaustedError();
    if (!res.ok) {
      throw new TtsSynthError(`Resemble synthesis failed (${res.status})`, { status: res.status });
    }

    let json: SynthJson;
    try {
      json = (await res.json()) as SynthJson;
    } catch {
      throw new TtsSynthError('Resemble synthesis returned invalid JSON', { status: res.status });
    }

    if (json.success === false) {
      throw new TtsSynthError('Resemble synthesis rejected the request', {
        status: res.status,
        issues: json.issues,
      });
    }
    if (typeof json.audio_content !== 'string') {
      throw new TtsSynthError('Resemble synthesis returned no audio', {
        status: res.status,
        issues: json.issues,
      });
    }

    return {
      audio: Buffer.from(json.audio_content, 'base64'),
      durationSeconds: typeof json.duration === 'number' ? json.duration : 0,
    };
  };

  const getWallet = async (): Promise<WalletSnapshot | null> => {
    try {
      const res = await fetchFn(WALLET_URL, { headers: { Authorization: `Bearer ${opts.apiKey}` } });
      if (!res.ok) return null;
      const json = (await res.json()) as WalletJson;
      const dollars = json.wallet?.balance_dollars;
      if (typeof dollars !== 'number' || !Number.isFinite(dollars)) return null;
      return { balanceDollars: dollars, lowBalance: json.wallet?.low_balance === true };
    } catch {
      return null;
    }
  };

  return {
    async synthesize(text) {
      const chunks = chunkText(text);
      if (chunks.length === 0) {
        throw new TtsSynthError('nothing to synthesise');
      }
      const parts: Buffer[] = [];
      let durationSeconds = 0;
      for (const chunk of chunks) {
        const piece = await synthesizeChunk(chunk);
        parts.push(piece.audio);
        durationSeconds += piece.durationSeconds;
      }
      return { audio: Buffer.concat(parts), durationSeconds };
    },
    async getWalletBalanceDollars() {
      const wallet = await getWallet();
      return wallet ? wallet.balanceDollars : null;
    },
    getWallet,
  };
}
