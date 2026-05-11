// =============================================================================
// session-start.test.ts — codex SessionStart handler
//
// Coverage:
//   1. First fire creates state with sessionStartFired=true
//   2. Double fire is ignored (idempotent — no state reset)
//   3. BreachSupport.loadOrCreate is invoked
//   4. session_start signal sent when dataSharing=true
//   5. dataSharing=false → no signal
//   6. resubmitUnsent backlog retry called (fail-open)
//   7. Field 4.0 IPC sync (mocked off)
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

import { handleSessionStart } from '../hooks/session-start';
import { loadState, loadOrCreateState, saveState } from '../state-store';
import type { PMatrixConfig, SessionStartInput } from '../types';

beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pmatrix-codex-sstart-'));
});

afterEach(() => {
  if (HOME && fs.existsSync(HOME)) {
    fs.rmSync(HOME, { recursive: true, force: true });
  }
});

function makeConfig(overrides: Partial<PMatrixConfig> = {}): PMatrixConfig {
  return {
    serverUrl: 'https://api.pmatrix.io',
    agentId: 'agent-codex-s',
    apiKey: 'key-cs',
    safetyGate: { enabled: true, serverTimeoutMs: 100, customToolRisk: {} },
    credentialProtection: { enabled: true, customPatterns: [] },
    killSwitch: { autoHaltOnRt: 0.75 },
    dataSharing: false,
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

describe('handleSessionStart — first fire', () => {
  test('creates state with sessionStartFired=true', async () => {
    const evt: SessionStartInput = {
      hook_event_name: 'SessionStart',
      session_id: 'sess-codex-start-1',
    };
    await handleSessionStart(evt, makeConfig(), makeClient());

    const state = loadState('sess-codex-start-1');
    expect(state).not.toBeNull();
    expect(state!.sessionStartFired).toBe(true);
  });

  test('framework default is codex (cross-SDK convention)', async () => {
    const evt: SessionStartInput = {
      hook_event_name: 'SessionStart',
      session_id: 'sess-codex-start-fw',
    };
    await handleSessionStart(evt, makeConfig(), makeClient());

    const state = loadState('sess-codex-start-fw');
    expect(state!.framework).toBe('codex');
  });

  test('resubmitUnsent backlog retry is invoked (fail-open)', async () => {
    const client = makeClient();
    const evt: SessionStartInput = {
      hook_event_name: 'SessionStart',
      session_id: 'sess-codex-start-resubmit',
    };
    await handleSessionStart(evt, makeConfig(), client);

    expect((client.resubmitUnsent as unknown as jest.Mock)).toHaveBeenCalledTimes(1);
  });
});

describe('handleSessionStart — double fire defense', () => {
  test('double fire is ignored (idempotent — no state reset)', async () => {
    const evt: SessionStartInput = {
      hook_event_name: 'SessionStart',
      session_id: 'sess-codex-start-2',
    };
    const cfg = makeConfig();
    const client = makeClient();

    await handleSessionStart(evt, cfg, client);

    // Mutate state to detect re-initialization
    const after1 = loadOrCreateState('sess-codex-start-2', 'agent-codex-s');
    after1.totalTurns = 99;
    saveState(after1);

    await handleSessionStart(evt, cfg, client);

    const after2 = loadState('sess-codex-start-2');
    expect(after2!.totalTurns).toBe(99); // not reset by double fire
  });

  test('double fire does NOT trigger second signal', async () => {
    const evt: SessionStartInput = {
      hook_event_name: 'SessionStart',
      session_id: 'sess-codex-start-3',
    };
    const cfg = makeConfig({ dataSharing: true });
    const client = makeClient();

    await handleSessionStart(evt, cfg, client);
    const after1Calls = (client.sendCritical as unknown as jest.Mock).mock.calls.length;

    await handleSessionStart(evt, cfg, client);
    const after2Calls = (client.sendCritical as unknown as jest.Mock).mock.calls.length;

    expect(after2Calls).toBe(after1Calls); // no additional sendCritical on duplicate
  });
});

describe('handleSessionStart — signal emission', () => {
  test('dataSharing=true → session_start signal sent', async () => {
    const client = makeClient();
    const evt: SessionStartInput = {
      hook_event_name: 'SessionStart',
      session_id: 'sess-codex-start-4',
    };
    await handleSessionStart(evt, makeConfig({ dataSharing: true }), client);

    expect((client.sendCritical as unknown as jest.Mock)).toHaveBeenCalledTimes(1);
    const callArgs = (client.sendCritical as unknown as jest.Mock).mock.calls[0]![0];
    expect(callArgs.metadata.event_type).toBe('session_start');
    expect(callArgs.framework).toBe('codex');
    expect(callArgs.signal_source).toBe('codex_hook');
  });

  test('dataSharing=false → no signal sent', async () => {
    const client = makeClient();
    const evt: SessionStartInput = {
      hook_event_name: 'SessionStart',
      session_id: 'sess-codex-start-5',
    };
    await handleSessionStart(evt, makeConfig({ dataSharing: false }), client);

    expect((client.sendCritical as unknown as jest.Mock)).toHaveBeenCalledTimes(0);
  });

  test('signal includes session_id metadata', async () => {
    const client = makeClient();
    const evt: SessionStartInput = {
      hook_event_name: 'SessionStart',
      session_id: 'sess-codex-start-6',
    };
    await handleSessionStart(evt, makeConfig({ dataSharing: true }), client);

    const callArgs = (client.sendCritical as unknown as jest.Mock).mock.calls[0]![0];
    expect(callArgs.metadata.session_id).toBe('sess-codex-start-6');
  });
});
