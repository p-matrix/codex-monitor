// =============================================================================
// @pmatrix/codex-monitor — cli/setup.ts
// Setup command: writes P-MATRIX hooks to ~/.codex/hooks.json
//
// Usage:
//   pmatrix-codex setup
//   pmatrix-codex setup --agent-id <id> --api-key <key>
//   pmatrix-codex setup --repo                        (writes <cwd>/.codex/hooks.json)
//
// What it does:
//   1. Resolves the path to the pmatrix-codex binary
//   2. Reads/creates ~/.codex/hooks.json (or <repo>/.codex/hooks.json with --repo)
//   3. Merges in the P-MATRIX hook configuration (idempotent)
//   4. Saves the file
//   5. Prints confirmation with next steps
//
// Hook events configured (Codex CLI v0.124+):
//   - SessionStart
//   - UserPromptSubmit (gate hook — credential scan)
//   - PreToolUse (gate hook — Safety Gate)
//   - PermissionRequest (gate hook)
//   - PostToolUse
//   - Stop
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Codex hooks.json shape (partial) ────────────────────────────────────────

interface CodexHookEntry {
  type: 'command';
  command: string;
  timeout?: number;
}

interface CodexHookMatcher {
  hooks: CodexHookEntry[];
  matcher?: string;
}

interface CodexSettings {
  hooks?: Record<string, CodexHookMatcher[]>;
  [key: string]: unknown;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function runSetup(): Promise<void> {
  const binaryPath = resolveBinaryPath();

  const args = process.argv.slice(3);
  const agentId = getFlag(args, '--agent-id');
  const apiKey = getFlag(args, '--api-key');
  const useRepo = args.includes('--repo');

  // Update ~/.pmatrix/config.json if flags provided
  if (agentId || apiKey) {
    updatePMatrixConfig({ agentId, apiKey });
  }

  // Resolve hooks.json path: ~/.codex/hooks.json or <cwd>/.codex/hooks.json
  const settingsPath = useRepo
    ? path.join(process.cwd(), '.codex', 'hooks.json')
    : path.join(os.homedir(), '.codex', 'hooks.json');

  const settings = readJsonOrEmpty<CodexSettings>(settingsPath);

  // Build hook config
  const hookConfig = buildHookConfig(binaryPath);

  // Merge hooks (idempotent — does not duplicate pmatrix-codex entries)
  settings.hooks = mergeHooks(settings.hooks ?? {}, hookConfig);

  // Write
  const settingsDir = path.dirname(settingsPath);
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');

  // Print confirmation
  console.log('');
  console.log('✓ P-MATRIX Codex Monitor hooks registered');
  console.log(`  Config: ${settingsPath}`);
  console.log(`  Binary: ${binaryPath}`);
  console.log('');
  console.log('Hooks registered (Codex CLI v0.124+):');
  console.log('  • SessionStart        → Session bootstrap + state load');
  console.log('  • UserPromptSubmit    → Credential scan (16 patterns) + frequency');
  console.log('  • PreToolUse          → Safety Gate (Bash / apply_patch / MCP tools)');
  console.log('  • PermissionRequest   → Approval workflow + Kill Switch (secondary)');
  console.log('  • PostToolUse         → R(t) update + apply_patch AP-2 file_write');
  console.log('  • Stop                → session_report + breach flush');
  console.log('');

  if (!agentId) {
    console.log('Next step: set your Agent ID');
    console.log('  pmatrix-codex setup --agent-id <YOUR_AGENT_ID>');
    console.log('  or: PMATRIX_AGENT_ID=<id> in your shell');
    console.log('');
  }

  if (!apiKey) {
    console.log('Next step: set your API key');
    console.log('  export PMATRIX_API_KEY=<YOUR_API_KEY>');
    console.log('  or add to ~/.pmatrix/config.json: { "apiKey": "${PMATRIX_API_KEY}" }');
    console.log('');
  }

  console.log('Restart Codex CLI to activate monitoring.');
  console.log('Dashboard: https://app.pmatrix.io');
  console.log('');
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function buildHookConfig(binaryPath: string): Record<string, CodexHookMatcher[]> {
  return {
    SessionStart: [
      { hooks: [{ type: 'command', command: `${binaryPath} session-start` }] },
    ],
    UserPromptSubmit: [
      { hooks: [{ type: 'command', command: `${binaryPath} user-prompt-submit`, timeout: 5 }] },
    ],
    PreToolUse: [
      { hooks: [{ type: 'command', command: `${binaryPath} pre-tool-use`, timeout: 5 }] },
    ],
    PermissionRequest: [
      { hooks: [{ type: 'command', command: `${binaryPath} permission-request`, timeout: 5 }] },
    ],
    PostToolUse: [
      { hooks: [{ type: 'command', command: `${binaryPath} post-tool-use` }] },
    ],
    Stop: [
      { hooks: [{ type: 'command', command: `${binaryPath} stop` }] },
    ],
  };
}

function mergeHooks(
  existing: Record<string, CodexHookMatcher[]>,
  newHooks: Record<string, CodexHookMatcher[]>
): Record<string, CodexHookMatcher[]> {
  const result = { ...existing };

  for (const [event, matchers] of Object.entries(newHooks)) {
    if (!result[event]) {
      result[event] = matchers;
      continue;
    }

    const existingList = result[event]!;
    const alreadyInstalled = existingList.some((m) =>
      m.hooks.some((h) => h.command.includes('pmatrix-codex'))
    );

    if (!alreadyInstalled) {
      result[event] = [...existingList, ...matchers];
    }
    // If already installed, leave as-is (idempotent)
  }

  return result;
}

function resolveBinaryPath(): string {
  const scriptPath = process.argv[1];

  if (scriptPath) {
    const binName = path.basename(scriptPath);
    if (binName === 'pmatrix-codex') {
      return 'pmatrix-codex';  // rely on PATH
    }

    const distDir = path.dirname(scriptPath);
    const candidate = path.join(path.dirname(distDir), 'node_modules', '.bin', 'pmatrix-codex');
    if (fs.existsSync(candidate)) return candidate;
  }

  return 'pmatrix-codex';
}

function readJsonOrEmpty<T>(filePath: string): T {
  try {
    if (!fs.existsSync(filePath)) return {} as T;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return {} as T;
  }
}

function updatePMatrixConfig(updates: { agentId?: string; apiKey?: string }): void {
  const configPath = path.join(os.homedir(), '.pmatrix', 'config.json');
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });

  const existing = readJsonOrEmpty<Record<string, unknown>>(configPath);

  if (updates.agentId) existing['agentId'] = updates.agentId;
  if (updates.apiKey)  existing['apiKey']  = updates.apiKey;

  fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  console.log(`  Saved config: ${configPath}`);
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}
