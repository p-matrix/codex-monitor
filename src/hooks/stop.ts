// =============================================================================
// @pmatrix/codex-monitor — hooks/stop.ts
// Stop hook handler — turn end, session_report, breach flush
//
// Codex CLI Stop fires at turn end (semantic equivalent to claude-code-monitor
// SessionEnd).
//
// Flow:
//   - Send session_summary signal (4-axis aggregate)
//   - Emit Breach Taxonomy session_report observation
//   - Cleanup BreachSupport state + session state
// =============================================================================

import {
  PMatrixConfig,
  StopInput,
  SignalPayload,
} from '../types';
import { PMatrixHttpClient, SessionSummaryInput } from '../client';
import {
  loadOrCreateState,
  deleteState,
  PersistedSessionState,
} from '../state-store';
import { BreachSupport } from '../breach-support';

export async function handleStop(
  event: StopInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<void> {
  const { session_id, end_reason } = event;
  const agentId = config.agentId;

  const state = loadOrCreateState(session_id, agentId);

  if (config.debug) {
    process.stderr.write(
      `[P-MATRIX] Stop: session=${session_id} turns=${state.totalTurns} ` +
      `grade=${state.grade ?? 'N/A'} halted=${state.isHalted}\n`
    );
  }

  // Send session summary (dataSharing required)
  if (config.dataSharing) {
    const summaryInput: SessionSummaryInput = {
      sessionId: session_id,
      agentId,
      totalTurns: state.totalTurns,
      dangerEvents: state.dangerEvents,
      credentialBlocks: state.credentialBlocks,
      safetyGateBlocks: state.safetyGateBlocks,
      endReason: end_reason,
      signal_source: 'codex_hook',
      framework: 'codex',
      framework_tag: config.frameworkTag ?? 'stable',
    };
    await client.sendSessionSummary(summaryInput).catch(() => {});

    // Breach Taxonomy: emit session_report observation signal
    const breachSupport = BreachSupport.loadOrCreate(agentId, session_id);
    const sessionReport = breachSupport.getSessionReport();
    const reportSignal = buildSessionSignal(state, session_id, {
      event_type: 'session_report',
      subject: 'RPT-001',
      report_type: sessionReport.report_type,
      actions_summary: sessionReport.actions_summary,
      session_duration_ms: sessionReport.session_duration_ms,
      priority: 'normal',
    }, config.frameworkTag ?? 'stable');
    client.sendCritical(reportSignal).catch(() => {});
  }

  // Clean up session state + breach state
  BreachSupport.deleteState(session_id);
  deleteState(session_id);
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
