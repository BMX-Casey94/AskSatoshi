/**
 * Bridge to the BSV-AIO-MCP server. The MCP is stdio-only, so we keep it alive as a
 * long-running child process and speak JSON-RPC via the official SDK. The server is
 * read-only and fail-closed by design; our job is lifecycle management, defensive
 * argument mapping (its tool schema is discovered at connect time), and timeouts.
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const INVESTIGATE_TIMEOUT_MS = 20_000;
const RECONNECT_DELAY_MS = 5_000;
/**
 * The initialize handshake must outlast the child's first-boot SQLite ingest. On a
 * throttled serverless CPU that can take minutes (the SDK default of 60s is not
 * enough); once the index is cached in the instance's tmpdir, warm boots are fast.
 */
const CONNECT_TIMEOUT_MS = 300_000;
/** How long a chat request may wait for a cold MCP child to become ready. */
const WARMUP_TIMEOUT_MS = 4_000;
const WARMUP_POLL_MS = 100;

/** Resolve the installed bsv-aio-mcp entry point without assuming its layout. */
export function resolveMcpEntry(): string {
  const require = createRequire(import.meta.url);
  let pkgDir: string;
  try {
    pkgDir = dirname(require.resolve('bsv-aio-mcp/package.json'));
  } catch {
    throw new Error(
      'bsv-aio-mcp is not installed. Run `npm install` at the repository root first.',
    );
  }

  const candidates: string[] = [];
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      bin?: string | Record<string, string>;
    };
    if (typeof pkg.bin === 'string') candidates.push(pkg.bin);
    else if (pkg.bin && typeof pkg.bin === 'object') candidates.push(...Object.values(pkg.bin));
  } catch {
    // Fall through to the known-layout candidates below.
  }
  candidates.push('server/dist/index.mjs', 'dist/index.mjs', 'index.mjs');

  for (const rel of candidates) {
    const abs = join(pkgDir, rel);
    if (existsSync(abs)) return abs;
  }
  throw new Error(`Could not locate the bsv-aio-mcp entry point under ${pkgDir}.`);
}

type ToolSchema = {
  properties?: Record<string, { type?: string }>;
  required?: string[];
};

/** Pick the most likely question argument from the investigate tool's input schema. */
export function pickQuestionArg(schema: ToolSchema | undefined): string {
  const props = schema?.properties ?? {};
  const preferred = ['query', 'question', 'q', 'topic', 'input', 'prompt', 'text'];
  for (const name of preferred) {
    if (name in props) return name;
  }
  const requiredString = (schema?.required ?? []).find((k) => props[k]?.type === 'string');
  if (requiredString) return requiredString;
  const firstString = Object.entries(props).find(([, v]) => v?.type === 'string')?.[0];
  return firstString ?? 'query';
}

export class McpBridge {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private questionArg = 'query';
  private reconnectTimer: NodeJS.Timeout | null = null;
  private intentionallyClosed = false;
  private lastError: string | null = null;

  get connected(): boolean {
    return this.client !== null;
  }

  /** Last connection failure, for the /api/health diagnostic. */
  get lastConnectError(): string | null {
    return this.lastError;
  }

  /**
   * Give a cold start a short window to come up before we fall back to the corpus.
   * Never throws — a still-missing MCP is handled downstream.
   */
  async waitUntilConnected(timeoutMs = WARMUP_TIMEOUT_MS): Promise<boolean> {
    if (this.client) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.client) return true;
      await new Promise((resolve) => setTimeout(resolve, WARMUP_POLL_MS));
    }
    return this.client !== null;
  }

  async connect(): Promise<void> {
    const entry = resolveMcpEntry();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: {
        ...getDefaultEnvironment(),
        // getDefaultEnvironment() forwards only an allowlist, so pass the index/root
        // overrides explicitly — on a long-running host these point the child's SQLite
        // index at a persistent path instead of the per-boot tmpdir.
        ...(process.env.BSV_AIO_DB_PATH ? { BSV_AIO_DB_PATH: process.env.BSV_AIO_DB_PATH } : {}),
        ...(process.env.BSV_AIO_ROOT ? { BSV_AIO_ROOT: process.env.BSV_AIO_ROOT } : {}),
      },
      stderr: 'pipe',
    });
    // Surface the child's stderr on failure — on a serverless instance a missing
    // snapshot or a spawn error is otherwise invisible until every question fails.
    const stderr: string[] = [];
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk.toString());
      if (stderr.join('').length > 8_000) stderr.shift();
    });
    const client = new Client(
      { name: 'ask-satoshi', version: '1.0.0' },
      { capabilities: {} },
    );

    transport.onclose = () => {
      this.client = null;
      this.transport = null;
      if (!this.intentionallyClosed) this.scheduleReconnect();
    };

    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      this.lastError = null;
    } catch (err) {
      const detail = stderr.join('').trim();
      const message = `MCP child failed to start (entry ${entry})${detail ? `: ${detail.slice(-500)}` : ''}`;
      this.lastError = err instanceof Error ? `${message} [${err.message}]` : message;
      // A failed handshake leaves the transport half-open; close it so the child is
      // reaped and the reconnect loop starts from a clean slate.
      await client.close().catch(() => undefined);
      throw new Error(message, { cause: err });
    }

    // Discover the investigate tool's argument name rather than assuming it.
    const { tools } = await client.listTools();
    const investigate = tools.find((t) => t.name === 'investigate');
    if (!investigate) {
      await client.close().catch(() => undefined);
      throw new Error('bsv-aio-mcp did not advertise an `investigate` tool.');
    }
    this.questionArg = pickQuestionArg(investigate.inputSchema as ToolSchema);

    this.transport = transport;
    this.client = client;
  }

  /** Query the pinned snapshot. Throws Error('MCP_UNAVAILABLE') when the child is down. */
  async investigate(question: string, context?: string): Promise<unknown> {
    const args: Record<string, string> = { [this.questionArg]: question };
    if (context) args.context = context;
    return this.callJson('investigate', args);
  }

  /** Raw ranked hits for a query, with optional kind/era filters. */
  async searchKnowledge(
    query: string,
    filters?: { kind?: string[]; era?: string; authority_max?: number },
    limit = 30,
  ): Promise<unknown> {
    return this.callJson('search_knowledge', { query, filters, limit });
  }

  /** Full stored body of a document by its locator/URI. */
  async getResource(uri: string): Promise<unknown> {
    return this.callJson('get_resource', { uri });
  }

  private async callJson(tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) throw new Error('MCP_UNAVAILABLE');
    let result;
    try {
      result = await this.client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: INVESTIGATE_TIMEOUT_MS,
      });
    } catch (err) {
      if (err instanceof Error && /timeout|timed out/i.test(err.message)) {
        throw new Error('MCP_TIMEOUT');
      }
      throw err;
    }
    const content: unknown = (result as { content?: unknown }).content;
    const text = (Array.isArray(content) ? content : [])
      .filter((c): c is { type: 'text'; text: string } =>
        typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'text',
      )
      .map((c) => c.text)
      .join('\n');
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  async close(): Promise<void> {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const client = this.client;
    this.client = null;
    this.transport = null;
    if (client) await client.close().catch(() => undefined);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => {
        console.error('[mcp] reconnect failed:', err instanceof Error ? err.message : err);
        this.scheduleReconnect();
      });
    }, RECONNECT_DELAY_MS);
  }
}
