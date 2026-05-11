// =============================================================================
// config.test.ts — loadConfig env var parsing + defaults
//
// Coverage:
//   1. Defaults when no file + no env
//   2. PMATRIX_API_KEY / PMATRIX_AGENT_ID / PMATRIX_SERVER_URL env overrides
//   3. PMATRIX_DEBUG=1 → debug=true
//   4. ${ENV_VAR} ref in apiKey resolves
//   5. File config merges with defaults
// =============================================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadConfig } from '../config';

let TMP_DIR = '';

beforeEach(() => {
  TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pmatrix-cfg-'));
  delete process.env['PMATRIX_API_KEY'];
  delete process.env['PMATRIX_AGENT_ID'];
  delete process.env['PMATRIX_SERVER_URL'];
  delete process.env['PMATRIX_DEBUG'];
  delete process.env['CUSTOM_KEY_REF'];
});

afterEach(() => {
  if (TMP_DIR && fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

function writeConfig(content: object): string {
  const filePath = path.join(TMP_DIR, 'config.json');
  fs.writeFileSync(filePath, JSON.stringify(content), 'utf-8');
  return filePath;
}

// ── 1. Defaults ───────────────────────────────────────────────────────────────

describe('loadConfig — defaults', () => {
  test('non-existent file → defaults', () => {
    const cfg = loadConfig(path.join(TMP_DIR, 'nope.json'));
    expect(cfg.serverUrl).toBe('https://api.pmatrix.io');
    expect(cfg.agentId).toBe('');
    expect(cfg.apiKey).toBe('');
    expect(cfg.debug).toBe(false);
    expect(cfg.dataSharing).toBe(false);
    expect(cfg.frameworkTag).toBe('stable');
    expect(cfg.safetyGate.enabled).toBe(true);
    expect(cfg.killSwitch.autoHaltOnRt).toBe(0.75);
  });
});

// ── 2. Env var overrides ─────────────────────────────────────────────────────

describe('loadConfig — env var overrides', () => {
  test('PMATRIX_API_KEY overrides file value', () => {
    const file = writeConfig({ apiKey: 'from-file' });
    process.env['PMATRIX_API_KEY'] = 'from-env';
    const cfg = loadConfig(file);
    expect(cfg.apiKey).toBe('from-env');
  });

  test('PMATRIX_AGENT_ID overrides file value', () => {
    const file = writeConfig({ agentId: 'agent-from-file' });
    process.env['PMATRIX_AGENT_ID'] = 'agent-from-env';
    const cfg = loadConfig(file);
    expect(cfg.agentId).toBe('agent-from-env');
  });

  test('PMATRIX_SERVER_URL overrides file value', () => {
    const file = writeConfig({ serverUrl: 'https://file.url' });
    process.env['PMATRIX_SERVER_URL'] = 'https://env.url';
    const cfg = loadConfig(file);
    expect(cfg.serverUrl).toBe('https://env.url');
  });

  test('PMATRIX_DEBUG=1 → debug=true', () => {
    process.env['PMATRIX_DEBUG'] = '1';
    const cfg = loadConfig(path.join(TMP_DIR, 'nope.json'));
    expect(cfg.debug).toBe(true);
  });

  test('PMATRIX_DEBUG unset → debug=false', () => {
    const cfg = loadConfig(path.join(TMP_DIR, 'nope.json'));
    expect(cfg.debug).toBe(false);
  });
});

// ── 3. Env var ref in apiKey ──────────────────────────────────────────────────

describe('loadConfig — ${ENV_VAR} ref in apiKey', () => {
  test('${CUSTOM_KEY_REF} resolves from env', () => {
    process.env['CUSTOM_KEY_REF'] = 'resolved-key-value';
    const file = writeConfig({ apiKey: '${CUSTOM_KEY_REF}' });
    const cfg = loadConfig(file);
    expect(cfg.apiKey).toBe('resolved-key-value');
  });

  test('${UNDEFINED_REF} → undefined → falls through to default', () => {
    const file = writeConfig({ apiKey: '${UNDEFINED_REF}' });
    const cfg = loadConfig(file);
    expect(cfg.apiKey).toBe('');
  });

  test('plain string apiKey passes through unchanged', () => {
    const file = writeConfig({ apiKey: 'plain-secret' });
    const cfg = loadConfig(file);
    expect(cfg.apiKey).toBe('plain-secret');
  });
});

// ── 4. File config merging ────────────────────────────────────────────────────

describe('loadConfig — file overrides + nested defaults', () => {
  test('partial safetyGate config merges with defaults', () => {
    const file = writeConfig({ safetyGate: { serverTimeoutMs: 5_000 } });
    const cfg = loadConfig(file);
    expect(cfg.safetyGate.enabled).toBe(true);  // default
    expect(cfg.safetyGate.serverTimeoutMs).toBe(5_000);  // overridden
  });

  test('partial killSwitch config merges with defaults', () => {
    const file = writeConfig({ killSwitch: { autoHaltOnRt: 0.90 } });
    const cfg = loadConfig(file);
    expect(cfg.killSwitch.autoHaltOnRt).toBe(0.90);
  });

  test('frameworkTag from file', () => {
    const file = writeConfig({ frameworkTag: 'beta' });
    const cfg = loadConfig(file);
    expect(cfg.frameworkTag).toBe('beta');
  });

  test('dataSharing from file', () => {
    const file = writeConfig({ dataSharing: true });
    const cfg = loadConfig(file);
    expect(cfg.dataSharing).toBe(true);
  });
});
