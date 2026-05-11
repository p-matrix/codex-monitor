// =============================================================================
// @pmatrix/codex-monitor — hooks/session-start.ts
// SessionStart hook handler — session bootstrap
//
// Codex CLI emits SessionStart at session begin or resume.
// Observation only (no blocking).
//
// Flow:
//   - cleanupStaleStates (opportunistic, fail-open)
//   - loadOrCreateState
//   - sessionStartFired double-fire defense
//   - Send session_start signal (fire-and-forget)
//   - Resubmit unsent backlog (60s throttle)
//   - saveState
// =============================================================================

import {
  PMatrixConfig,
  SessionStartInput,
  SignalPayload,
} from '../types';
import { PMatrixHttpClient } from '../client';
import {
  loadOrCreateState,
  saveState,
  cleanupStaleStates,
  PersistedSessionState,
} from '../state-store';
import { BreachSupport } from '../breach-support';

export async function handleSessionStart(
  event: SessionStartInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<void> {
  const { session_id } = event;
  const agentId = config.agentId;

  // Cleanup stale sessions opportunistically (non-blocking)
  cleanupStaleStates();

  // Load or create session state
  const state = loadOrCreateState(session_id, agentId);

  // Guard: SessionStart double-fire defense
  if (state.sessionStartFired) {
    if (config.debug) {
      process.stderr.write(
        `[P-MATRIX] SessionStart: duplicate fire ignored session=${session_id}\n`
      );
    }
    return;
  }
  state.sessionStartFired = true;

  // Initialize breach support persistence (Codex shares 5 SDK breach format)
  const breach = BreachSupport.loadOrCreate(agentId, session_id);
  breach.saveState(session_id);

  if (config.debug) {
    process.stderr.write(
      `[P-MATRIX] SessionStart: session=${session_id} agent=${agentId}\n`
    );
  }

  // Send session_start signal (fire-and-forget)
  if (config.dataSharing) {
    const signal = buildSessionSignal(state, session_id, {
      event_type: 'session_start',
      priority: 'normal',
    }, config.frameworkTag ?? 'stable');
    client.sendCritical(signal).catch(() => {});
  }

  // Retry unsent backlog from previous sessions (60s throttle, fail-open)
  client.resubmitUnsent().catch(() => {});

  saveState(state);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildSessionSignal(
  state: PersistedSessionState,
  sessionId: string,
  metadata: Record<string, unknown>,
  frameworkTag: 'beta' | 'stable'
): SignalPayload {
  return {
    agent_id: state.agentId,
    // Neutral signal (0.5) — avoids all-zero → R(t)=0.75 HALT on server
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
      session_id: sessionId,
      ...metadata,
    },
    state_vector: null,
  };
}
