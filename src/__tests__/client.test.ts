// =============================================================================
// client.test.ts — PMatrixHttpClient cross-cutting features (v0.7.0)
//
// Coverage:
//   1. extractRtFromResponse — complete and partial responses
//   2. X-Request-ID — outgoing header sent on every request (cross-cutting B)
//   3. Bearer auth header
//   4. 5xx error_id surfacing on stderr (cross-cutting A)
//   5. 429 backoff escalation (cross-cutting C) — Retry-After preferred
//   6. sendBatch — empty array short circuit
// =============================================================================

import { PMatrixHttpClient } from '../client';
import type { PMatrixConfig, BatchSendResponse, SignalPayload } from '../types';

// fs I/O mocked so backupToLocal does not touch the dev's home dir
jest.mock('fs', () => ({
  ...jest.requireActual<typeof import('fs')>('fs'),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  promises: {
    readdir: jest.fn().mockRejectedValue({ code: 'ENOENT' }),
    stat: jest.fn(),
    readFile: jest.fn(),
    unlink: jest.fn(),
    mkdir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<PMatrixConfig> = {}): PMatrixConfig {
  return {
    serverUrl: 'https://api.pmatrix.io',
    agentId: 'test-agent',
    apiKey: 'test-key',
    safetyGate: { enabled: true, serverTimeoutMs: 2_500, customToolRisk: {} },
    credentialProtection: { enabled: true, customPatterns: [] },
    killSwitch: { autoHaltOnRt: 0.75 },
    dataSharing: true,
    batch: { maxSize: 10, flushIntervalMs: 2_000, retryMax: 0 },
    frameworkTag: 'stable',
    debug: false,
    ...overrides,
  };
}

function makeSignal(): SignalPayload {
  return {
    agent_id: 'test-agent',
    baseline: 0.5,
    norm: 0.5,
    stability: 0.5,
    meta_control: 0.5,
    timestamp: new Date().toISOString(),
    signal_source: 'codex_hook',
    framework: 'codex',
    framework_tag: 'stable',
    schema_version: '0.3',
    metadata: { event_type: 'unit_test' },
    state_vector: null,
  };
}

interface MockResponseInit {
  ok?: boolean;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function buildResponse(init: MockResponseInit = {}): Response {
  const status = init.status ?? 200;
  const ok = init.ok ?? (status >= 200 && status < 300);
  const headerMap = new Map<string, string>(
    Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const bodyText = typeof init.body === 'string' ? init.body : JSON.stringify(init.body ?? {});
  return {
    ok,
    status,
    headers: {
      get(name: string) {
        return headerMap.get(name.toLowerCase()) ?? null;
      },
    },
    text: jest.fn().mockResolvedValue(bodyText),
  } as unknown as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env['PMATRIX_LOCAL_URL'];
  delete process.env['PMATRIX_DEBUG_TRACE'];
});

// ── 1. extractRtFromResponse ──────────────────────────────────────────────────

describe('extractRtFromResponse', () => {
  test('full response → returns rt/grade/mode/axes', () => {
    const res: BatchSendResponse = {
      received: 1,
      risk: 0.25,
      grade: 'B',
      mode: 'caution',
      axes: { baseline: 0.5, norm: 0.5, stability: 0.5, meta_control: 0.5 },
    };
    const out = PMatrixHttpClient.extractRtFromResponse(res);
    expect(out).not.toBeNull();
    expect(out!.rt).toBe(0.25);
    expect(out!.grade).toBe('B');
    expect(out!.mode).toBe('caution');
  });

  test('missing risk → null', () => {
    const res: BatchSendResponse = { received: 1 };
    expect(PMatrixHttpClient.extractRtFromResponse(res)).toBeNull();
  });
});

// ── 2. X-Request-ID outgoing header (cross-cutting B) ─────────────────────────

describe('X-Request-ID outgoing header (cross-cutting B)', () => {
  test('every request includes an X-Request-ID header', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      buildResponse({ status: 200, body: { received: 1 } }),
    );
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const client = new PMatrixHttpClient(makeConfig());
    await client.sendBatch([makeSignal()]);

    expect(fetchMock).toHaveBeenCalled();
    const call = fetchMock.mock.calls[0]!;
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    const reqId = headers['X-Request-ID'];
    expect(reqId).toBeDefined();
    expect(typeof reqId).toBe('string');
    expect((reqId ?? '').length).toBeGreaterThan(0);
    // also retains Bearer auth
    expect(headers['Authorization']).toBe('Bearer test-key');
  });

  test('two consecutive requests use distinct request ids', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      buildResponse({ status: 200, body: { received: 1 } }),
    );
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const client = new PMatrixHttpClient(makeConfig());
    await client.sendBatch([makeSignal()]);
    await client.sendBatch([makeSignal()]);

    const id1 = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    const id2 = (fetchMock.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(id1['X-Request-ID']).not.toBe(id2['X-Request-ID']);
  });
});

// ── 3. error_id stderr surfacing (cross-cutting A) ────────────────────────────

describe('error_id stderr surfacing (cross-cutting A)', () => {
  test('5xx body containing error_id is logged to stderr', async () => {
    const errBody = JSON.stringify({
      error: { error_id: 'err-abc-123', request_id: 'req-xyz-789', message: 'boom' },
    });
    const fetchMock = jest.fn().mockResolvedValue(
      buildResponse({ status: 500, body: errBody }),
    );
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    const client = new PMatrixHttpClient(makeConfig());

    await expect(client.sendBatch([makeSignal()])).rejects.toThrow(/HTTP 500/);

    const allWrites = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(allWrites).toContain('error_id=err-abc-123');
    expect(allWrites).toContain('request_id=req-xyz-789');
    expect(allWrites).toContain('Support');
    stderrSpy.mockRestore();
  });

  test('5xx with X-Error-ID header (no body) still surfaces correlation', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      buildResponse({
        status: 503,
        body: 'plain non-json error',
        headers: { 'X-Error-ID': 'hdr-err-1', 'X-Request-ID': 'hdr-req-1' },
      }),
    );
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    const client = new PMatrixHttpClient(makeConfig());

    await expect(client.sendBatch([makeSignal()])).rejects.toThrow();

    const allWrites = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(allWrites).toContain('error_id=hdr-err-1');
    expect(allWrites).toContain('request_id=hdr-req-1');
    stderrSpy.mockRestore();
  });

  test('4xx (non-429) does NOT trigger error_id stderr', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      buildResponse({ status: 400, body: { error: { error_id: 'should-not-show' } } }),
    );
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    const client = new PMatrixHttpClient(makeConfig());
    await expect(client.sendBatch([makeSignal()])).rejects.toThrow();

    const allWrites = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(allWrites).not.toContain('error_id=should-not-show');
    stderrSpy.mockRestore();
  });
});

// ── 4. 429 burst handling (cross-cutting C) ───────────────────────────────────

describe('429 burst handling (cross-cutting C)', () => {
  test('429 with Retry-After triggers retry, then succeeds', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(buildResponse({
        status: 429,
        body: 'rate limited',
        headers: { 'Retry-After': '0' },  // 0s → schedule with no real delay
      }))
      .mockResolvedValueOnce(buildResponse({ status: 200, body: { received: 1 } }));
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const client = new PMatrixHttpClient(makeConfig({
      batch: { maxSize: 10, flushIntervalMs: 2_000, retryMax: 2 },
    }));

    const result = await client.sendBatch([makeSignal()]);
    expect(result).toEqual({ received: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 15_000);

  test('repeated 429 finally throws after retry budget', async () => {
    const fetchMock = jest.fn().mockResolvedValue(buildResponse({
      status: 429,
      body: 'still limited',
      headers: { 'Retry-After': '0' },  // 0s → no real wait
    }));
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const client = new PMatrixHttpClient(makeConfig({
      batch: { maxSize: 10, flushIntervalMs: 2_000, retryMax: 2 },
    }));

    await expect(client.sendBatch([makeSignal()])).rejects.toThrow(/HTTP 429/);
    // 1 initial + 2 retries = 3 total attempts
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 20_000);
});

// ── 5. sendBatch shortcut ─────────────────────────────────────────────────────

describe('sendBatch — shortcut paths', () => {
  test('empty array returns immediately without fetch', async () => {
    const fetchMock = jest.fn();
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const client = new PMatrixHttpClient(makeConfig());
    const result = await client.sendBatch([]);
    expect(result).toEqual({ received: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
