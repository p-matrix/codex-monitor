// =============================================================================
// @pmatrix/codex-monitor — client.ts
// PMatrixHttpClient: POST /v1/inspect/stream, GET /v1/agents/{id}/public
// 95% reuse from @pmatrix/openclaw-monitor — signal_source + framework changed
// signal_source: 'codex_hook', framework: 'codex'
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  PMatrixConfig,
  SignalPayload,
  GradeResponse,
  AgentGradeDetail,
  BatchSendResponse,
  AxesState,
  SafetyMode,
  TrustGrade,
} from './types';

// ─── Runtime shape guards ─────────────────────────────────────────────────────
// Defensive checks that detect payload schema drift at runtime.
// Throws if response is malformed; monitor's caller treats as network failure.

function assertGradeResponseShape(raw: unknown): asserts raw is GradeResponse {
  if (!raw || typeof raw !== 'object') {
    throw new Error('PMatrix API: GradeResponse payload not an object');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.agent_id !== 'string' || typeof r.grade !== 'string' || !r.axes) {
    throw new Error('PMatrix API: GradeResponse missing required fields (agent_id/grade/axes)');
  }
}

function assertAgentGradeDetailShape(raw: unknown): asserts raw is AgentGradeDetail {
  if (!raw || typeof raw !== 'object') {
    throw new Error('PMatrix API: AgentGradeDetail payload not an object');
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.history)) {
    throw new Error('PMatrix API: AgentGradeDetail.history missing or not an array');
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const RETRY_DELAYS = [100, 500, 2_000] as const;
/**
 * Burst-rate 429 backoff schedule (v0.7.0 cross-cutting C).
 * Used when server middleware (burst_rate_limit) replies HTTP 429.
 * Retry-After header takes precedence when present.
 */
const BURST_RETRY_DELAYS = [1_000, 5_000, 30_000] as const;
const REQUEST_TIMEOUT_MS = 10_000;
/** Cap applied when Retry-After is absent or too aggressive */
const MAX_BURST_BACKOFF_MS = 30_000;

const RESUBMIT_INTERVAL_MS = 60_000;
const MAX_RESUBMIT_FILES   = 5;
const MAX_UNSENT_AGE_MS    = 7 * 24 * 60 * 60 * 1_000;

// ─── Response interfaces ──────────────────────────────────────────────────────

export interface SessionSummaryInput {
  sessionId: string;
  agentId: string;
  totalTurns: number;
  dangerEvents: number;
  credentialBlocks: number;
  safetyGateBlocks: number;
  endReason?: string;
  signal_source: 'codex_hook';
  framework: 'codex';
  framework_tag: 'beta' | 'stable';
}

// ─── PMatrixHttpClient ────────────────────────────────────────────────────────

export class PMatrixHttpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly agentId: string;
  private readonly retryMax: number;
  private readonly debug: boolean;
  private lastResubmitAt: number = 0;

  /**
   * Local sidecar URL for try-local-fallback-server pattern.
   * When set, sendBatch tries localhost sidecar first, then falls back to server.
   * Default: http://127.0.0.1:9850 (set PMATRIX_LOCAL_URL to override).
   */
  private readonly localUrl: string | null;

  constructor(config: PMatrixConfig) {
    this.baseUrl = config.serverUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.agentId = config.agentId;
    this.retryMax = config.batch.retryMax;
    this.debug = config.debug;
    this.localUrl = (config as any).localUrl ?? process.env.PMATRIX_LOCAL_URL ?? null;
  }

  async getAgentGrade(agentId: string): Promise<GradeResponse> {
    const url = `${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/public`;
    const raw = await this.fetchWithRetry('GET', url, null);
    assertGradeResponseShape(raw);
    return raw as GradeResponse;
  }

  /**
   * GET /v1/agents/{id}/grade — current grade + history list
   * Phase 0 ③ confirmed: endpoint returns history[]
   */
  async getAgentGradeDetail(agentId: string): Promise<AgentGradeDetail> {
    const url = `${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/grade`;
    const raw = await this.fetchWithRetry('GET', url, null);
    assertAgentGradeDetailShape(raw);
    return raw as AgentGradeDetail;
  }

  async sendBatch(signals: SignalPayload[]): Promise<BatchSendResponse> {
    if (signals.length === 0) return { received: 0 };
    // Defense-in-depth: all-zero axes → R(t)=0.75 → instant HALT.
    // Correct to neutral (0.5) before transmission.
    for (const s of signals) {
      if (s.baseline === 0 && s.norm === 0 && s.stability === 0 && s.meta_control === 0) {
        s.baseline = 0.5;
        s.norm = 0.5;
        s.stability = 0.5;
        s.meta_control = 0.5;
      }
    }
    try {
      return await this.sendBatchDirect(signals);
    } catch (err) {
      await this.backupToLocal(signals);
      throw err;
    }
  }

  /**
   * Send a single signal and return the server response with R(t)/Grade.
   * Used by hook handlers for synchronous gate decisions.
   * Timeout-aware: caller applies serverTimeoutMs via Promise.race.
   */
  async sendSignal(signal: SignalPayload): Promise<BatchSendResponse> {
    return this.sendBatch([signal]);
  }

  async resubmitUnsent(): Promise<void> {
    const now = Date.now();
    if (now - this.lastResubmitAt < RESUBMIT_INTERVAL_MS) return;
    this.lastResubmitAt = now;

    const dir = path.join(os.homedir(), '.pmatrix', 'unsent');
    let files: string[];
    try {
      files = (await fs.promises.readdir(dir))
        .filter(f => f.endsWith('.json'))
        .sort()
        .slice(0, MAX_RESUBMIT_FILES);
    } catch {
      return;
    }

    for (const filename of files) {
      const filepath = path.join(dir, filename);
      try {
        const stat = await fs.promises.stat(filepath);
        if (now - stat.mtimeMs > MAX_UNSENT_AGE_MS) {
          await fs.promises.unlink(filepath);
          continue;
        }
        const raw = await fs.promises.readFile(filepath, 'utf-8');
        const signals = JSON.parse(raw) as SignalPayload[];
        await this.sendBatchDirect(signals);
        await fs.promises.unlink(filepath);
      } catch (err) {
        if (err instanceof SyntaxError) {
          await fs.promises.unlink(filepath).catch(() => {});
        }
      }
    }
  }

  async sendCritical(signal: SignalPayload): Promise<void> {
    const url = `${this.baseUrl}/v1/inspect/stream`;
    try {
      await this.fetchOnce('POST', url, signal);
    } catch {
      await this.backupToLocal([signal]);
    }
  }

  /**
   * Session summary — sent on SessionEnd
   * signal_source: 'codex_hook', framework: 'codex'
   */
  async sendSessionSummary(data: SessionSummaryInput): Promise<void> {
    const url = `${this.baseUrl}/v1/inspect/stream`;
    const payload: SignalPayload = {
      agent_id: data.agentId,
      // Neutral signal — avoids all-zero → R(t)=0.75 HALT
      baseline: 0.5,
      norm: 0.5,
      stability: 0.5,
      meta_control: 0.5,
      timestamp: new Date().toISOString(),
      signal_source: 'codex_hook',
      framework: 'codex',
      framework_tag: data.framework_tag,
      schema_version: '0.3',
      metadata: {
        event_type: 'session_summary',
        session_id: data.sessionId,
        total_turns: data.totalTurns,
        danger_events: data.dangerEvents,
        credential_blocks: data.credentialBlocks,
        safety_gate_blocks: data.safetyGateBlocks,
        end_reason: data.endReason,
        priority: 'normal',
      },
      state_vector: null,
    };

    try {
      await this.fetchWithRetry('POST', url, payload);
    } catch {
      await this.backupToLocal([payload]);
    }
  }

  static extractRtFromResponse(res: BatchSendResponse): {
    rt: number;
    mode: SafetyMode;
    grade: TrustGrade;
    axes: AxesState;
  } | null {
    if (
      res.risk == null ||
      res.grade == null ||
      res.mode == null ||
      res.axes == null
    ) {
      return null;
    }
    return {
      rt: res.risk,
      mode: res.mode,
      grade: res.grade,
      axes: {
        baseline: res.axes.baseline,
        norm: res.axes.norm,
        stability: res.axes.stability,
        meta_control: res.axes.meta_control,
      },
    };
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private async sendBatchDirect(signals: SignalPayload[]): Promise<BatchSendResponse> {
    const body = signals.length === 1 ? signals[0] : signals;

    // Try local sidecar first (if available)
    if (this.localUrl) {
      try {
        const localEndpoint = `${this.localUrl}/v1/inspect/local`;
        const raw = await this.fetchOnce('POST', localEndpoint, body);
        if (this.debug) {
          process.stderr.write(`[P-MATRIX] Local sidecar response received\n`);
        }
        return (raw as BatchSendResponse | null) ?? { received: signals.length };
      } catch {
        // Local sidecar unavailable — fall through to server
        if (this.debug) {
          process.stderr.write(`[P-MATRIX] Local sidecar unavailable, falling back to server\n`);
        }
      }
    }

    // Server path (with retries)
    const url = `${this.baseUrl}/v1/inspect/stream`;
    const raw = await this.fetchWithRetry('POST', url, body);
    return (raw as BatchSendResponse | null) ?? { received: signals.length };
  }

  private async fetchWithRetry(
    method: string,
    url: string,
    body: unknown
  ): Promise<unknown> {
    let lastError: Error = new Error('Unknown error');

    for (let attempt = 0; attempt <= this.retryMax; attempt++) {
      try {
        return await this.fetchOnce(method, url, body);
      } catch (err) {
        lastError = err as Error;
        if (attempt < this.retryMax) {
          // v0.7.0 cross-cutting C: 429 burst — prefer Retry-After header,
          // otherwise escalating BURST_RETRY_DELAYS.
          const burstHint = (lastError as Error & { __retryAfterMs?: number; __status?: number });
          let delay: number;
          if (burstHint.__status === 429) {
            const retryAfterMs = burstHint.__retryAfterMs;
            if (retryAfterMs && retryAfterMs > 0) {
              delay = Math.min(retryAfterMs, MAX_BURST_BACKOFF_MS);
            } else {
              delay = BURST_RETRY_DELAYS[attempt] ?? MAX_BURST_BACKOFF_MS;
            }
          } else {
            delay = RETRY_DELAYS[attempt] ?? 2_000;
          }
          if (this.debug) {
            process.stderr.write(
              `[P-MATRIX] Retry ${attempt + 1}/${this.retryMax} after ${delay}ms: ${lastError.message}\n`
            );
          }
          await sleep(delay);
        }
      }
    }

    throw lastError;
  }

  private async fetchOnce(
    method: string,
    url: string,
    body: unknown
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    // v0.7.0 cross-cutting B: outgoing X-Request-ID for server correlation.
    // crypto.randomUUID() — Node 18+ built-in, available in this engine target.
    const reqId = generateRequestId();

    try {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'X-Request-ID': reqId,
      };

      const response = await fetch(url, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      // v0.7.0 cross-cutting B: trace echoed X-Request-ID for debugging
      if (process.env['PMATRIX_DEBUG_TRACE']) {
        const echoed = response.headers.get('X-Request-ID') ?? reqId;
        process.stderr.write(
          `[P-MATRIX] trace req_id=${echoed} status=${response.status}\n`
        );
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');

        // v0.7.0 cross-cutting C: 429 burst → tag error so fetchWithRetry
        // can apply Retry-After / BURST_RETRY_DELAYS backoff schedule.
        if (response.status === 429) {
          const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
          const err = new Error(`HTTP 429: ${text.slice(0, 200)}`) as Error & {
            __retryAfterMs?: number;
            __status?: number;
          };
          err.__status = 429;
          if (retryAfterMs !== null) err.__retryAfterMs = retryAfterMs;
          throw err;
        }

        // v0.7.0 cross-cutting A: emit error_id for support correlation on 5xx.
        if (response.status >= 500) {
          this.emitErrorCorrelation(response, text);
        }

        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      }

      const text = await response.text();
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * v0.7.0 cross-cutting A — Error correlation logging.
   * Server (Production Polish A) returns error_id / request_id in body + headers.
   * Surface them on stderr so users can include the ID in support requests.
   */
  private emitErrorCorrelation(response: Response, rawText: string): void {
    let bodyErrorId: string | undefined;
    let bodyRequestId: string | undefined;
    try {
      const parsed = rawText ? JSON.parse(rawText) : null;
      if (parsed && typeof parsed === 'object') {
        const errObj = (parsed as Record<string, unknown>)['error'];
        if (errObj && typeof errObj === 'object') {
          const e = errObj as Record<string, unknown>;
          if (typeof e['error_id'] === 'string') bodyErrorId = e['error_id'];
          if (typeof e['request_id'] === 'string') bodyRequestId = e['request_id'];
        }
      }
    } catch {
      // body not JSON → fall back to headers only
    }
    const headerErrorId = response.headers.get('X-Error-ID') ?? undefined;
    const headerRequestId = response.headers.get('X-Request-ID') ?? undefined;
    const errorId = bodyErrorId ?? headerErrorId ?? 'unknown';
    const requestId = bodyRequestId ?? headerRequestId ?? 'unknown';
    process.stderr.write(
      `[P-MATRIX] Error ${response.status}: error_id=${errorId} request_id=${requestId} ` +
      `— Support 문의 시 Error ID 함께 제공해 주세요.\n`
    );
  }

  private async backupToLocal(signals: SignalPayload[]): Promise<void> {
    try {
      const dir = path.join(os.homedir(), '.pmatrix', 'unsent');
      await fs.promises.mkdir(dir, { recursive: true });
      const filename = path.join(dir, `${Date.now()}.json`);
      await fs.promises.writeFile(filename, JSON.stringify(signals, null, 2), 'utf-8');
    } catch {
      process.stderr.write('[P-MATRIX] backupToLocal failed — data not persisted\n');
    }
  }
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate a request id for X-Request-ID header (v0.7.0 cross-cutting B).
 * Prefers crypto.randomUUID() (Node 18+); falls back to a timestamp-based id.
 */
function generateRequestId(): string {
  try {
    // Node 18+ has globalThis.crypto with randomUUID
    const c: { randomUUID?: () => string } | undefined =
      (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c && typeof c.randomUUID === 'function') {
      return c.randomUUID();
    }
  } catch {
    // fall through
  }
  return `pm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Parse Retry-After header (delta-seconds OR HTTP-date) into milliseconds.
 * Returns null when header is missing or unparseable.
 */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;

  // delta-seconds (integer)
  const asInt = Number(trimmed);
  if (Number.isFinite(asInt) && asInt >= 0) {
    return Math.floor(asInt * 1000);
  }

  // HTTP-date (RFC 7231)
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }

  return null;
}
