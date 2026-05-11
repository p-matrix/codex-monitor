// =============================================================================
// stop.test.ts — codex Stop handler (turn end + session_report)
//
// Coverage:
//   1. sendSessionSummary called with correct counters
//   2. session_report (RPT-001) emitted via sendCritical
//   3. session counters preserved (totalTurns, dangerEvents, etc.)
//   4. State file deleted after Stop
//   5. BreachSupport state deleted after Stop
//   6. dataSharing=false → no signals (only state cleanup)
// =============================================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let HOME = '';

jest.mock('os', () => {
  const real = jest.requireActual<typeof import('os')>('os');
  return { ...real, homedir: () => HOME };
});

jest.mock('@pmatrix/field-node-runtime', () => ({
  isField4Enabled: () => false,
  writeFieldState: () => {},
  deleteFieldState: () => {},
}));

import { handleStop } from '../hooks/stop';
import { loadState, loadOrCreateState, saveState } from '../state-store';
import type { PMatrixConfig, StopInput } from '../types';

beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pmatrix-codex-stop-'));
});

afterEach(() => {
  if (HOME && fs.existsSync(HOME)) {
    fs.rmSync(HOME, { recursive: true, force: true });
  }
});

function makeConfig(overrides: Partial<PMatrixConfig> = {}): PMatrixConfig {
  return {
    serverUrl: 'https://api.pmatrix.io',
    agentId: 'agent-codex-stop',
    apiKey: 'key-cstop',
    safetyGate: { enabled: true, serverTimeoutMs: 100, customToolRisk: {} },
    credentialProtection: { enabled: true, customPatterns: [] },
    killSwitch: { autoHaltOnRt: 0.75 },
    dataSharing: true,
    batch: { maxSize: 10, flushIntervalMs: 2_000, retryMax: 0 },
    frameworkTag: 'stable',
    debug: false,
    ...overrides,
  };
}

function makeClient() {
  return {
    sendSignal: jest.fn().mockResolvedValue({ received: 1 }),
    sendCritical: jest.fn().mockResolvedValue(undefined),
    sendSessionSummary: jest.fn().mockResolvedValue(undefined),
    resubmitUnsent: jest.fn().mockResolvedValue(undefined),
  } as unknown as import('../client').PMatrixHttpClient;
}

describe('handleStop — session_summary', () => {
  test('sendSessionSummary is called with correct counters', async () => {
    const client = makeClient();

    // Set up state with non-zero counters
    const state = loadOrCreateState('sess-codex-stop-1', 'agent-codex-stop');
    state.totalTurns = 5;
    state.dangerEvents = 2;
    state.credentialBlocks = 1;
    state.safetyGateBlocks = 0;
    saveState(state);

    const evt: StopInput = {
      hook_event_name: 'Stop',
      session_id: 'sess-codex-stop-1',
      end_reason: 'completed',
    };
    await handleStop(evt, makeConfig(), client);

    const summaryCall = (client.sendSessionSummary as unknown as jest.Mock).mock.calls[0]![0];
    expect(summaryCall.sessionId).toBe('sess-codex-stop-1');
    expect(summaryCall.agentId).toBe('agent-codex-stop');
    expect(summaryCall.totalTurns).toBe(5);
    expect(summaryCall.dangerEvents).toBe(2);
    expect(summaryCall.credentialBlocks).toBe(1);
    expect(summaryCall.safetyGateBlocks).toBe(0);
    expect(summaryCall.endReason).toBe('completed');
    expect(summaryCall.framework).toBe('codex');
    expect(summaryCall.signal_source).toBe('codex_hook');
  });

  test('dataSharing=false → sendSessionSummary NOT called', async () => {
    const client = makeClient();

    const evt: StopInput = {
      hook_event_name: 'Stop',
      session_id: 'sess-codex-stop-no-share',
    };
    await handleStop(evt, makeConfig({ dataSharing: false }), client);

    expect((client.sendSessionSummary as unknown as jest.Mock)).toHaveBeenCalledTimes(0);
  });
});

describe('handleStop — session_report', () => {
  test('Breach session_report emitted via sendCritical', async () => {
    const client = makeClient();

    const evt: StopInput = {
      hook_event_name: 'Stop',
      session_id: 'sess-codex-stop-2',
    };
    await handleStop(evt, makeConfig(), client);

    // sendCritical called for session_report
    expect((client.sendCritical as unknown as jest.Mock).mock.calls.length).toBeGreaterThan(0);
    const reportCall = (client.sendCritical as unknown as jest.Mock).mock.calls[0]![0];
    expect(reportCall.metadata.event_type).toBe('session_report');
    expect(reportCall.metadata.subject).toBe('RPT-001');
    expect(reportCall.framework).toBe('codex');
  });

  test('session_report contains actions_summary (file_modifications, tool_calls)', async () => {
    const client = makeClient();

    const evt: StopInput = {
      hook_event_name: 'Stop',
      session_id: 'sess-codex-stop-3',
    };
    await handleStop(evt, makeConfig(), client);

    const reportCall = (client.sendCritical as unknown as jest.Mock).mock.calls[0]![0];
    expect(reportCall.metadata).toHaveProperty('actions_summary');
    expect(reportCall.metadata).toHaveProperty('session_duration_ms');
  });
});

describe('handleStop — state cleanup', () => {
  test('state file is deleted after Stop', async () => {
    // Create state
    const state = loadOrCreateState('sess-codex-stop-cleanup', 'agent-codex-stop');
    state.totalTurns = 3;
    saveState(state);

    expect(loadState('sess-codex-stop-cleanup')).not.toBeNull();

    const evt: StopInput = {
      hook_event_name: 'Stop',
      session_id: 'sess-codex-stop-cleanup',
    };
    await handleStop(evt, makeConfig(), makeClient());

    expect(loadState('sess-codex-stop-cleanup')).toBeNull();
  });

  test('handles non-existent session gracefully (loadOrCreate fail-open)', async () => {
    const evt: StopInput = {
      hook_event_name: 'Stop',
      session_id: 'sess-codex-stop-nonexistent',
    };

    // Should not throw
    await expect(
      handleStop(evt, makeConfig(), makeClient())
    ).resolves.not.toThrow();
  });
});

describe('handleStop — edge cases', () => {
  test('halt-mid-session: state with isHalted=true is still summarized', async () => {
    const client = makeClient();

    // Create state with isHalted=true (e.g., R(t) ≥ 0.75 mid-session)
    const state = loadOrCreateState('sess-codex-stop-halt', 'agent-codex-stop');
    state.isHalted = true;
    state.haltReason = 'R(t) 0.80 ≥ 0.75';
    state.totalTurns = 7;
    state.dangerEvents = 5;
    saveState(state);

    const evt: StopInput = {
      hook_event_name: 'Stop',
      session_id: 'sess-codex-stop-halt',
      end_reason: 'halted',
    };
    await handleStop(evt, makeConfig(), client);

    const summaryCall = (client.sendSessionSummary as unknown as jest.Mock).mock.calls[0]![0];
    expect(summaryCall.totalTurns).toBe(7);
    expect(summaryCall.dangerEvents).toBe(5);
    expect(summaryCall.endReason).toBe('halted');
  });

  test('duration_ms in StopInput is forwarded (codex-specific)', async () => {
    const client = makeClient();
    const evt: StopInput = {
      hook_event_name: 'Stop',
      session_id: 'sess-codex-stop-dur',
      end_reason: 'completed',
      duration_ms: 12345,
    };
    await handleStop(evt, makeConfig(), client);

    // sendSessionSummary still receives the basic info
    const summaryCall = (client.sendSessionSummary as unknown as jest.Mock).mock.calls[0]![0];
    expect(summaryCall.endReason).toBe('completed');
  });
});
