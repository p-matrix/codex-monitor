// =============================================================================
// @pmatrix/codex-monitor — hooks/post-tool-use.ts
// PostToolUse hook handler — observation + apply_patch AP-2 file_write
//
// Codex 고유 features:
//   - apply_patch / Edit / Write tool_name 감지 → AP-2 file_write event
//   - tool_input.path / file_path / filename 추출 → breach.isInScope('AP-2', filePath)
//   - duration_ms 수집 → R(t) latency axis (server-side)
//
// Privacy-first:
//   - file_path string only (no file content)
//   - tool_input 내부 (patch / diff content) 미전송
// =============================================================================

import {
  PMatrixConfig,
  PostToolUseInput,
  SignalPayload,
} from '../types';
import { PMatrixHttpClient } from '../client';
import {
  loadOrCreateState,
  saveState,
  pushToolDuration,
  PersistedSessionState,
} from '../state-store';
import { BreachSupport } from '../breach-support';

const APPLY_PATCH_TOOL_NAMES = ['apply_patch', 'Edit', 'Write'];

export async function handlePostToolUse(
  event: PostToolUseInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<void> {
  const { session_id, tool_name, duration_ms, tool_input } = event;
  const agentId = config.agentId;

  const state = loadOrCreateState(session_id, agentId);
  const breach = BreachSupport.loadOrCreate(agentId, session_id);

  // Capture duration_ms for latency telemetry (R(t) latency axis is server-side)
  if (typeof duration_ms === 'number') {
    pushToolDuration(state, duration_ms);
  }

  // apply_patch / Edit / Write — AP-2 file_write event
  if (APPLY_PATCH_TOOL_NAMES.includes(tool_name)) {
    breach.incrementFileModifications();

    // Extract file_path from tool_input (privacy: path string only, no content)
    const filePath = extractFilePath(tool_input);
    const inScope: boolean = filePath ? (breach.isInScope('AP-2', filePath) ?? false) : false;

    if (config.debug) {
      process.stderr.write(
        `[P-MATRIX] PostToolUse apply_patch: tool=${tool_name} ` +
        `path=${filePath ?? '?'} in_scope=${inScope} duration_ms=${duration_ms ?? '?'}\n`
      );
    }

    if (config.dataSharing) {
      const signal = buildAP2Signal(
        state,
        session_id,
        tool_name,
        filePath,
        inScope,
        config.frameworkTag ?? 'stable',
        duration_ms
      );
      client.sendCritical(signal).catch(() => {});
    }
  } else {
    // Generic PostToolUse observation (no AP-2)
    if (config.debug) {
      process.stderr.write(
        `[P-MATRIX] PostToolUse: tool=${tool_name} ` +
        `duration_ms=${duration_ms ?? '?'} session=${session_id}\n`
      );
    }

    if (config.dataSharing) {
      const signal = buildObservationSignal(
        state,
        session_id,
        tool_name,
        config.frameworkTag ?? 'stable',
        duration_ms
      );
      client.sendCritical(signal).catch(() => {});
    }
  }

  breach.saveState(session_id);
  saveState(state);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract file_path from tool_input (apply_patch / Edit / Write).
 * Codex tool_input shape varies by tool — try common keys.
 * Privacy-first: path string only, no content extraction.
 */
function extractFilePath(tool_input?: Record<string, unknown>): string | null {
  if (!tool_input) return null;

  // Common keys: 'path', 'file_path', 'filename'
  const candidates = ['path', 'file_path', 'filename'];
  for (const key of candidates) {
    const v = tool_input[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }

  return null;
}

function buildAP2Signal(
  state: PersistedSessionState,
  sessionId: string,
  toolName: string,
  filePath: string | null,
  inScope: boolean,
  frameworkTag: 'beta' | 'stable',
  durationMs?: number
): SignalPayload {
  return {
    agent_id: state.agentId,
    baseline: 0.5,
    norm: 0.5,
    stability: 0.5,
    meta_control: 0.5,
    timestamp: new Date().toISOString(),
    signal_source: 'codex_hook',
    framework: 'codex',
    framework_tag: frameworkTag,
    schema_version: '0.3',
    metadata: {
      event_type: 'file_write',
      session_id: sessionId,
      tool_name: toolName,
      file_path: filePath ?? undefined,
      in_scope: inScope,
      action_primitive: 'AP-2',
      duration_ms: durationMs,
      priority: 'normal',
    },
    state_vector: null,
  };
}

function buildObservationSignal(
  state: PersistedSessionState,
  sessionId: string,
  toolName: string,
  frameworkTag: 'beta' | 'stable',
  durationMs?: number
): SignalPayload {
  return {
    agent_id: state.agentId,
    baseline: 0.5,
    norm: 0.5,
    stability: 0.5,
    meta_control: 0.5,
    timestamp: new Date().toISOString(),
    signal_source: 'codex_hook',
    framework: 'codex',
    framework_tag: frameworkTag,
    schema_version: '0.3',
    metadata: {
      event_type: 'post_tool_use',
      session_id: sessionId,
      tool_name: toolName,
      duration_ms: durationMs,
      priority: 'normal',
    },
    state_vector: null,
  };
}
