#!/usr/bin/env node
// =============================================================================
// @pmatrix/codex-monitor — index.ts
// CLI entry point: reads Codex CLI hook event from stdin, dispatches to
// handler, writes hook response JSON to stdout.
//
// Usage (configured in ~/.codex/hooks.json):
//   pmatrix-codex session-start
//   pmatrix-codex user-prompt-submit
//   pmatrix-codex pre-tool-use
//   pmatrix-codex permission-request
//   pmatrix-codex post-tool-use
//   pmatrix-codex stop
//   pmatrix-codex setup          -- writes hook config to ~/.codex/hooks.json
//
// Stdin:  Codex hook event JSON
// Stdout: Codex hook response JSON (for PreToolUse / PermissionRequest)
// Stderr: Debug logs (only when PMATRIX_DEBUG=1)
//
// Exit codes:
//   0  — success (allow or deny via JSON output)
//   1  — error (fail-open: Codex continues, non-blocking)
//   2  — blocked (UserPromptSubmit credential gate)
// =============================================================================

import { loadConfig } from './config';
import { PMatrixHttpClient } from './client';
import {
  CodexHookInput,
  PreToolUseInput,
  PermissionRequestInput,
  SessionStartInput,
  UserPromptSubmitInput,
  PostToolUseInput,
  StopInput,
} from './types';
import { handleSessionStart } from './hooks/session-start';
import { handleUserPromptSubmit } from './hooks/user-prompt-submit';
import { handlePreToolUse } from './hooks/pre-tool-use';
import { handlePermissionRequest } from './hooks/permission-request';
import { handlePostToolUse } from './hooks/post-tool-use';
import { handleStop } from './hooks/stop';

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const subcommand = process.argv[2];

  // Setup command — delegates to cli/setup
  if (subcommand === 'setup') {
    const { runSetup } = await import('./cli/setup.js');
    await runSetup();
    return;
  }

  // All other subcommands: read stdin, dispatch, write stdout
  const rawInput = await readStdin();
  if (!rawInput.trim()) {
    process.exit(0);
    return;
  }

  let event: CodexHookInput;
  try {
    event = JSON.parse(rawInput) as CodexHookInput;
  } catch {
    // Invalid JSON — fail-open
    process.exit(0);
    return;
  }

  const config = loadConfig();

  // Validate prerequisites
  if (!config.agentId) {
    if (config.debug) {
      process.stderr.write('[P-MATRIX] No agentId configured — run: pmatrix-codex setup\n');
    }
    process.exit(0);
    return;
  }
  if (!config.apiKey) {
    if (config.debug) {
      process.stderr.write('[P-MATRIX] No apiKey configured — set PMATRIX_API_KEY\n');
    }
    process.exit(0);
    return;
  }
  const client = new PMatrixHttpClient(config);

  // Determine effective subcommand: prefer CLI arg, fall back to hook_event_name
  const hookName =
    subcommand ??
    (event as unknown as Record<string, unknown>)['hook_event_name'] as string | undefined;

  try {
    switch (hookName) {
      case 'session-start':
      case 'SessionStart': {
        await handleSessionStart(event as SessionStartInput, config, client);
        break;
      }

      case 'user-prompt-submit':
      case 'UserPromptSubmit': {
        const result = await handleUserPromptSubmit(
          event as UserPromptSubmitInput,
          config,
          client
        );
        if (result.blocked) {
          process.stderr.write(result.reason ?? '[P-MATRIX] Credential detected in prompt\n');
          process.exit(2);
        }
        break;
      }

      case 'pre-tool-use':
      case 'PreToolUse': {
        const output = await handlePreToolUse(
          event as PreToolUseInput,
          config,
          client
        );
        process.stdout.write(JSON.stringify(output) + '\n');
        break;
      }

      case 'permission-request':
      case 'PermissionRequest': {
        const output = await handlePermissionRequest(
          event as PermissionRequestInput,
          config,
          client
        );
        process.stdout.write(JSON.stringify(output) + '\n');
        break;
      }

      case 'post-tool-use':
      case 'PostToolUse': {
        await handlePostToolUse(event as PostToolUseInput, config, client);
        break;
      }

      case 'stop':
      case 'Stop': {
        await handleStop(event as StopInput, config, client);
        break;
      }

      default: {
        if (config.debug) {
          process.stderr.write(`[P-MATRIX] Unknown hook event: ${String(hookName)}\n`);
        }
        break;
      }
    }

    process.exit(0);
  } catch (err) {
    // Any unhandled error → fail-open (exit 0)
    if (config.debug) {
      process.stderr.write(`[P-MATRIX] Hook error: ${(err as Error).message}\n`);
    }
    process.exit(0);
  }
}

// ─── Stdin reader ─────────────────────────────────────────────────────────────

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }

    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

// ─── Run ──────────────────────────────────────────────────────────────────────

main().catch(() => {
  // Top-level error — always fail-open
  process.exit(0);
});
