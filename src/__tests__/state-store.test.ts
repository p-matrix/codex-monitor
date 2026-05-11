// =============================================================================
// state-store.test.ts — File-based session state persistence
//
// Coverage:
//   1. loadOrCreateState — fresh state vs persisted state
//   2. saveState → loadState round trip (atomic write)
//   3. Counter increments (cwd / file / permission denied / elicitation / compact)
//   4. isHalted set / clear
//   5. pushToolDuration ring buffer cap (TOOL_DURATIONS_MAX)
//   6. Migration backfill for legacy state files (pre-v0.7.0 fields)
//   7. R(t) cache TTL helpers (isRtCacheValid + buildRtCacheExpiry)
//
// Each test uses a fresh tempdir HOME to avoid cross-pollution with the
// developer's real ~/.pmatrix directory.
// =============================================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mutable HOME stub — set per-test via os.homedir mock
let HOME = '';

jest.mock('os', () => {
  const real = jest.requireActual<typeof import('os')>('os');
  return {
    ...real,
    homedir: () => HOME,
  };
});

// Imports come AFTER the os mock so module-level helpers see the stub.
import {
  loadState,
  loadOrCreateState,
  saveState,
  deleteState,
  isRtCacheValid,
  buildRtCacheExpiry,
  pushToolDuration,
  TOOL_DURATIONS_MAX,
  PersistedSessionState,
} from '../state-store';

beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pmatrix-test-'));
});

afterEach(() => {
  if (HOME && fs.existsSync(HOME)) {
    fs.rmSync(HOME, { recursive: true, force: true });
  }
});

// ── loadOrCreateState ──────────────────────────────────────────────────────────

describe('loadOrCreateState', () => {
  test('returns default state when no file exists', () => {
    const state = loadOrCreateState('sess-1', 'agent-1');
    expect(state.sessionId).toBe('sess-1');
    expect(state.agentId).toBe('agent-1');
    expect(state.totalTurns).toBe(0);
    expect(state.isHalted).toBe(false);
    expect(state.cwdChangeCount).toBe(0);
    expect(state.fileChangeCount).toBe(0);
    expect(state.permissionDeniedCount).toBe(0);
    expect(state.toolDurations).toEqual([]);
  });

  test('initializes new counters at 0', () => {
    const state = loadOrCreateState('sess-2', 'agent-2');
    expect(state.elicitationCount).toBe(0);
    expect(state.compactCount).toBe(0);
    expect(state.taskCount).toBe(0);
    expect(state.stopFailureCount).toBe(0);
  });
});

// ── saveState round trip ───────────────────────────────────────────────────────

describe('saveState → loadState round trip', () => {
  test('persists state and reads it back', () => {
    const state = loadOrCreateState('sess-3', 'agent-3');
    state.totalTurns = 7;
    state.cwdChangeCount = 2;
    state.fileChangeCount = 5;
    state.permissionDeniedCount = 1;
    state.lastCwd = '/tmp/work';
    saveState(state);

    const reloaded = loadState('sess-3');
    expect(reloaded).not.toBeNull();
    expect(reloaded!.totalTurns).toBe(7);
    expect(reloaded!.cwdChangeCount).toBe(2);
    expect(reloaded!.fileChangeCount).toBe(5);
    expect(reloaded!.permissionDeniedCount).toBe(1);
    expect(reloaded!.lastCwd).toBe('/tmp/work');
  });

  test('isHalted set/clear persists', () => {
    const state = loadOrCreateState('sess-4', 'agent-4');
    state.isHalted = true;
    state.haltReason = 'R(t) high';
    saveState(state);

    const reloaded = loadOrCreateState('sess-4', 'agent-4');
    expect(reloaded.isHalted).toBe(true);
    expect(reloaded.haltReason).toBe('R(t) high');

    reloaded.isHalted = false;
    delete reloaded.haltReason;
    saveState(reloaded);

    const reloaded2 = loadOrCreateState('sess-4', 'agent-4');
    expect(reloaded2.isHalted).toBe(false);
  });

  test('counters increment correctly', () => {
    const state = loadOrCreateState('sess-5', 'agent-5');
    state.elicitationCount += 1;
    state.compactCount += 1;
    state.taskCount += 1;
    state.cwdChangeCount += 1;
    state.fileChangeCount += 1;
    state.permissionDeniedCount += 1;
    saveState(state);

    const reloaded = loadOrCreateState('sess-5', 'agent-5');
    expect(reloaded.elicitationCount).toBe(1);
    expect(reloaded.compactCount).toBe(1);
    expect(reloaded.taskCount).toBe(1);
    expect(reloaded.cwdChangeCount).toBe(1);
    expect(reloaded.fileChangeCount).toBe(1);
    expect(reloaded.permissionDeniedCount).toBe(1);
  });
});

// ── deleteState ────────────────────────────────────────────────────────────────

describe('deleteState', () => {
  test('removes the file', () => {
    const state = loadOrCreateState('sess-6', 'agent-6');
    saveState(state);
    expect(loadState('sess-6')).not.toBeNull();

    deleteState('sess-6');
    expect(loadState('sess-6')).toBeNull();
  });

  test('does not throw when file is missing', () => {
    expect(() => deleteState('non-existent-session')).not.toThrow();
  });
});

// ── pushToolDuration (ring buffer) ─────────────────────────────────────────────

describe('pushToolDuration — ring buffer cap', () => {
  function blank(): PersistedSessionState {
    return loadOrCreateState('sess-rb', 'agent-rb');
  }

  test('appends a value', () => {
    const s = blank();
    pushToolDuration(s, 100);
    expect(s.toolDurations).toEqual([100]);
  });

  test('keeps only last TOOL_DURATIONS_MAX values', () => {
    const s = blank();
    for (let i = 0; i < TOOL_DURATIONS_MAX + 5; i++) {
      pushToolDuration(s, i);
    }
    expect(s.toolDurations).toHaveLength(TOOL_DURATIONS_MAX);
    // oldest 5 dropped → first remaining is index 5
    expect(s.toolDurations[0]).toBe(5);
    expect(s.toolDurations[s.toolDurations.length - 1]).toBe(TOOL_DURATIONS_MAX + 4);
  });

  test('ignores non-finite or negative input', () => {
    const s = blank();
    pushToolDuration(s, Number.NaN);
    pushToolDuration(s, -1);
    pushToolDuration(s, Number.POSITIVE_INFINITY);
    expect(s.toolDurations).toEqual([]);
  });
});

// ── Migration backfill ────────────────────────────────────────────────────────

describe('migration backfill (legacy state files)', () => {
  test('legacy file without v0.7.0 fields is back-filled to defaults', () => {
    const dir = path.join(HOME, '.pmatrix', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const legacy = {
      sessionId: 'legacy',
      agentId: 'agent-legacy',
      startedAt: new Date().toISOString(),
      currentRt: 0,
      currentMode: 'normal',
      grade: null,
      rtCacheExpiry: new Date(0).toISOString(),
      isHalted: false,
      dangerEvents: 0,
      credentialBlocks: 0,
      safetyGateBlocks: 0,
      totalTurns: 0,
      permissionRequestCount: 0,
      subagentSpawnCount: 0,
      updatedAt: new Date().toISOString(),
      framework: 'codex',
      sessionStartFired: false,
      elicitationCount: 0,
      compactCount: 0,
      taskCount: 0,
      stopFailureCount: 0,
      // v0.7.0 fields intentionally missing
    };
    fs.writeFileSync(path.join(dir, 'legacy.json'), JSON.stringify(legacy), 'utf-8');

    const reloaded = loadOrCreateState('legacy', 'agent-legacy');
    expect(reloaded.cwdChangeCount).toBe(0);
    expect(reloaded.fileChangeCount).toBe(0);
    expect(reloaded.permissionDeniedCount).toBe(0);
    expect(reloaded.toolDurations).toEqual([]);
  });
});

// ── R(t) cache TTL helpers ────────────────────────────────────────────────────

describe('R(t) cache helpers', () => {
  test('buildRtCacheExpiry produces a timestamp roughly 30s in the future', () => {
    const before = Date.now();
    const expiryStr = buildRtCacheExpiry();
    const after = Date.now();
    const expiry = new Date(expiryStr).getTime();
    expect(expiry).toBeGreaterThanOrEqual(before + 25_000);
    expect(expiry).toBeLessThanOrEqual(after + 35_000);
  });

  test('isRtCacheValid returns true when expiry is in the future', () => {
    const state = loadOrCreateState('rt', 'agent');
    state.rtCacheExpiry = buildRtCacheExpiry();
    expect(isRtCacheValid(state)).toBe(true);
  });

  test('isRtCacheValid returns false when expiry is in the past', () => {
    const state = loadOrCreateState('rt2', 'agent');
    state.rtCacheExpiry = new Date(Date.now() - 1).toISOString();
    expect(isRtCacheValid(state)).toBe(false);
  });
});
