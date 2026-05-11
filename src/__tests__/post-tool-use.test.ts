// =============================================================================
// post-tool-use.test.ts — codex PostToolUse handler (apply_patch + AP-2)
//
// Coverage:
//   1. apply_patch tool_name detection (apply_patch / Edit / Write)
//   2. extractFilePath from tool_input.path / file_path / filename
//   3. AP-2 file_write signal emission (event_type, action_primitive)
//   4. duration_ms ring buffer accumulation
//   5. non-apply_patch tool → generic post_tool_use signal
//   6. dataSharing=false → no signal
//   7. fileModifications counter increment
// =============================================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let HOME = '';

jest.mock('os', () => {
  const real = jest.requireActual<typeof import('os')>('os');
  return { ...real, homedir: () => HOME };
});

import { handlePostToolUse } from '../hooks/post-tool-use';
import { loadOrCreateState } from '../state-store';
import { BreachSupport } from '../breach-support';
import type { PMatrixConfig, PostToolUseInput } from '../types';

beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pmatrix-codex-post-'));
});

afterEach(() => {
  if (HOME && fs.existsSync(HOME)) {
    fs.rmSync(HOME, { recursive: true, force: true });
  }
});

function makeConfig(overrides: Partial<PMatrixConfig> = {}): PMatrixConfig {
  return {
    serverUrl: 'https://api.pmatrix.io',
    agentId: 'agent-codex',
    apiKey: 'key-c',
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

function makeInput(opts: Partial<PostToolUseInput> = {}): PostToolUseInput {
  return {
    hook_event_name: 'PostToolUse',
    session_id: 'sess-codex-post-1',
    tool_name: 'Bash',
    ...opts,
  };
}

function makeClient() {
  return {
    sendSignal: jest.fn(),
    sendCritical: jest.fn().mockResolvedValue(undefined),
  } as unknown as import('../client').PMatrixHttpClient;
}

// ── apply_patch detection ────────────────────────────────────────────────────

describe('handlePostToolUse — apply_patch AP-2', () => {
  test('apply_patch tool_name → fileModifications increments', async () => {
    await handlePostToolUse(
      makeInput({ tool_name: 'apply_patch', tool_input: { path: '/src/foo.ts' } }),
      makeConfig(),
      makeClient(),
    );

    const breach = BreachSupport.loadOrCreate('agent-codex', 'sess-codex-post-1');
    const report = breach.getSessionReport();
    expect(report.actions_summary.file_modifications_count).toBe(1);
  });

  test('Edit matcher → fileModifications increments', async () => {
    await handlePostToolUse(
      makeInput({ tool_name: 'Edit', tool_input: { file_path: '/src/bar.ts' } }),
      makeConfig(),
      makeClient(),
    );

    const breach = BreachSupport.loadOrCreate('agent-codex', 'sess-codex-post-1');
    const report = breach.getSessionReport();
    expect(report.actions_summary.file_modifications_count).toBe(1);
  });

  test('Write matcher → fileModifications increments', async () => {
    await handlePostToolUse(
      makeInput({ tool_name: 'Write', tool_input: { filename: '/src/baz.ts' } }),
      makeConfig(),
      makeClient(),
    );

    const breach = BreachSupport.loadOrCreate('agent-codex', 'sess-codex-post-1');
    const report = breach.getSessionReport();
    expect(report.actions_summary.file_modifications_count).toBe(1);
  });

  test('non-apply_patch tool (Bash) → fileModifications NOT incremented', async () => {
    await handlePostToolUse(
      makeInput({ tool_name: 'Bash' }),
      makeConfig(),
      makeClient(),
    );

    const breach = BreachSupport.loadOrCreate('agent-codex', 'sess-codex-post-1');
    const report = breach.getSessionReport();
    expect(report.actions_summary.file_modifications_count).toBe(0);
  });

  test('mcp__ tool → fileModifications NOT incremented', async () => {
    await handlePostToolUse(
      makeInput({ tool_name: 'mcp__filesystem__read_file' }),
      makeConfig(),
      makeClient(),
    );

    const breach = BreachSupport.loadOrCreate('agent-codex', 'sess-codex-post-1');
    const report = breach.getSessionReport();
    expect(report.actions_summary.file_modifications_count).toBe(0);
  });
});

// ── duration_ms latency telemetry ────────────────────────────────────────────

describe('handlePostToolUse — duration_ms', () => {
  test('duration_ms is captured in toolDurations ring buffer', async () => {
    await handlePostToolUse(
      makeInput({ tool_name: 'Bash', duration_ms: 250 }),
      makeConfig(),
      makeClient(),
    );

    const state = loadOrCreateState('sess-codex-post-1', 'agent-codex');
    expect(state.toolDurations).toEqual([250]);
  });

  test('multiple duration_ms accumulate', async () => {
    await handlePostToolUse(makeInput({ duration_ms: 100 }), makeConfig(), makeClient());
    await handlePostToolUse(makeInput({ duration_ms: 200 }), makeConfig(), makeClient());
    await handlePostToolUse(makeInput({ duration_ms: 300 }), makeConfig(), makeClient());

    const state = loadOrCreateState('sess-codex-post-1', 'agent-codex');
    expect(state.toolDurations).toEqual([100, 200, 300]);
  });

  test('missing duration_ms does not push anything', async () => {
    await handlePostToolUse(makeInput(), makeConfig(), makeClient());
    const state = loadOrCreateState('sess-codex-post-1', 'agent-codex');
    expect(state.toolDurations).toEqual([]);
  });
});

// ── signal emission ──────────────────────────────────────────────────────────

describe('handlePostToolUse — signal emission', () => {
  test('apply_patch + dataSharing=true → sendCritical called', async () => {
    const client = makeClient();
    await handlePostToolUse(
      makeInput({ tool_name: 'apply_patch', tool_input: { path: '/src/foo.ts' } }),
      makeConfig({ dataSharing: true }),
      client,
    );
    expect((client.sendCritical as unknown as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  test('non-apply_patch + dataSharing=true → sendCritical called (generic observation)', async () => {
    const client = makeClient();
    await handlePostToolUse(
      makeInput({ tool_name: 'Bash' }),
      makeConfig({ dataSharing: true }),
      client,
    );
    expect((client.sendCritical as unknown as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  test('apply_patch + dataSharing=false → sendCritical NOT called', async () => {
    const client = makeClient();
    await handlePostToolUse(
      makeInput({ tool_name: 'apply_patch', tool_input: { path: '/src/foo.ts' } }),
      makeConfig({ dataSharing: false }),
      client,
    );
    expect((client.sendCritical as unknown as jest.Mock)).toHaveBeenCalledTimes(0);
  });

  test('apply_patch signal includes AP-2 metadata fields', async () => {
    const client = makeClient();
    await handlePostToolUse(
      makeInput({ tool_name: 'apply_patch', tool_input: { path: '/src/foo.ts' }, duration_ms: 50 }),
      makeConfig({ dataSharing: true }),
      client,
    );

    const callArgs = (client.sendCritical as unknown as jest.Mock).mock.calls[0]![0];
    expect(callArgs.metadata.event_type).toBe('file_write');
    expect(callArgs.metadata.action_primitive).toBe('AP-2');
    expect(callArgs.metadata.tool_name).toBe('apply_patch');
    expect(callArgs.metadata.file_path).toBe('/src/foo.ts');
    expect(callArgs.metadata.duration_ms).toBe(50);
    expect(callArgs.framework).toBe('codex');
    expect(callArgs.signal_source).toBe('codex_hook');
  });

  test('apply_patch with no path → file_path undefined, in_scope=false', async () => {
    const client = makeClient();
    await handlePostToolUse(
      makeInput({ tool_name: 'apply_patch', tool_input: {} }),
      makeConfig({ dataSharing: true }),
      client,
    );

    const callArgs = (client.sendCritical as unknown as jest.Mock).mock.calls[0]![0];
    expect(callArgs.metadata.file_path).toBeUndefined();
    expect(callArgs.metadata.in_scope).toBe(false);
  });

  test('non-apply_patch signal has post_tool_use event_type (no AP-2)', async () => {
    const client = makeClient();
    await handlePostToolUse(
      makeInput({ tool_name: 'Bash', duration_ms: 100 }),
      makeConfig({ dataSharing: true }),
      client,
    );

    const callArgs = (client.sendCritical as unknown as jest.Mock).mock.calls[0]![0];
    expect(callArgs.metadata.event_type).toBe('post_tool_use');
    expect(callArgs.metadata.action_primitive).toBeUndefined();
    expect(callArgs.metadata.tool_name).toBe('Bash');
    expect(callArgs.metadata.duration_ms).toBe(100);
  });
});
