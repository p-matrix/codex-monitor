// =============================================================================
// pre-tool-use.test.ts — Safety Gate handler integration
//
// Coverage:
//   1. Halt active → deny output (no client call needed)
//   2. Safety gate disabled → allow output
//   3. Normal flow → server call + ALLOW
//   4. BLOCK on critical+HIGH (server returns risk=0.6) → deny + counter inc
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

import { handlePreToolUse } from '../hooks/pre-tool-use';
import type { PMatrixConfig, PreToolUseInput } from '../types';

beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pmatrix-pre-'));
});

afterEach(() => {
  if (HOME && fs.existsSync(HOME)) {
    fs.rmSync(HOME, { recursive: true, force: true });
  }
});

function makeConfig(overrides: Partial<PMatrixConfig> = {}): PMatrixConfig {
  return {
    serverUrl: 'https://api.pmatrix.io',
    agentId: 'agent-x',
    apiKey: 'key-x',
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

function makeInput(toolName: string): PreToolUseInput {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'sess-pre-1',
    tool_name: toolName,
  };
}

function makeClient(rt: number | null) {
  return {
    sendSignal: jest.fn().mockResolvedValue(rt === null ? { received: 1 } : {
      received: 1,
      risk: rt,
      grade: rt > 0.5 ? 'D' : 'B',
      mode: rt > 0.5 ? 'critical' : 'caution',
      axes: { baseline: 0.5, norm: 0.5, stability: 0.5, meta_control: 0.5 },
    }),
    sendCritical: jest.fn().mockResolvedValue(undefined),
  } as unknown as import('../client').PMatrixHttpClient;
}

// ── 1. Halt active → deny ─────────────────────────────────────────────────────

describe('handlePreToolUse — global HALT', () => {
  test('HALT file present → deny without state load', async () => {
    fs.mkdirSync(path.join(HOME, '.pmatrix'), { recursive: true });
    fs.writeFileSync(path.join(HOME, '.pmatrix', 'HALT'), '{}', 'utf-8');

    const out = await handlePreToolUse(makeInput('bash'), makeConfig(), makeClient(null));
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('HALT');
  });
});

// ── 2. Safety gate disabled ───────────────────────────────────────────────────

describe('handlePreToolUse — safety gate disabled', () => {
  test('disabled → allow regardless of tool', async () => {
    const cfg = makeConfig({
      safetyGate: { enabled: false, serverTimeoutMs: 100, customToolRisk: {} },
    });
    const out = await handlePreToolUse(makeInput('bash'), cfg, makeClient(null));
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
  });
});

// ── 3. Normal flow → ALLOW ────────────────────────────────────────────────────

describe('handlePreToolUse — ALLOW path', () => {
  test('low-risk tool with R(t)=0.10 → allow', async () => {
    const out = await handlePreToolUse(
      makeInput('read_file'),
      makeConfig(),
      makeClient(0.10),
    );
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
  });
});

// ── 4. BLOCK on critical+HIGH ────────────────────────────────────────────────

describe('handlePreToolUse — BLOCK path', () => {
  test('high-risk tool with R(t)=0.60 → deny', async () => {
    const out = await handlePreToolUse(
      makeInput('bash'),
      makeConfig(),
      makeClient(0.60),
    );
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('Safety Gate');
  });
});
