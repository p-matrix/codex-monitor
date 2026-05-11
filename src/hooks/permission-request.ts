// =============================================================================
// @pmatrix/codex-monitor — hooks/permission-request.ts
// PermissionRequest hook handler — Kill Switch 2차 경로 (보조) + META_CONTROL 측정
//
// PermissionRequest is a secondary Kill Switch path.
// It fires when Claude presents a permission dialog.
// R(t) ≥ 0.75: deny + interrupt (session abort)
// R(t) < 0.75:  allow
//
// P3 추가: permissionRequestCount 카운터 증가 + META_CONTROL 빈도 신호 전송
// — 권한 요청 빈도는 에이전트 행동의 메타 패턴 지표 (META_CONTROL 축)
//
// ⚠️ NOT a reliable Kill Switch path:
//    - Only fires if Claude Code shows a permission dialog
//    - Claude may respond with text and bypass this hook
//    - PreToolUse deny is the primary (guaranteed) path
// =============================================================================

import {
  PMatrixConfig,
  PermissionRequestInput,
  PermissionRequestOutput,
  SignalPayload,
} from '../types';
import { PMatrixHttpClient } from '../client';
import { loadOrCreateState, saveState, isHaltActive } from '../state-store';
import { BreachSupport } from '../breach-support';

export async function handlePermissionRequest(
  event: PermissionRequestInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<PermissionRequestOutput> {
  const { session_id } = event;

  // ① HALT file check — global Kill Switch, checked before ANY state load
  // ~/.pmatrix/HALT presence → deny + interrupt immediately, no state I/O
  if (isHaltActive()) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'deny',
          message:
            'P-MATRIX Kill Switch HALT active. All tool calls blocked. Remove ~/.pmatrix/HALT to resume.',
          interrupt: true,
        },
      },
    };
  }

  // Safety Gate disabled — allow (META_CONTROL tracking skipped when gate is off)
  if (!config.safetyGate.enabled) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    };
  }

  const state = loadOrCreateState(session_id, config.agentId);

  // Breach Taxonomy: approval tracking (load persisted state)
  const breachSupport = BreachSupport.loadOrCreate(config.agentId, session_id);
  const approvalToolName = event.tool_name ?? 'unknown';
  const approvalActionId = `approval_${approvalToolName}_${Date.now()}`;
  breachSupport.recordApprovalRequested(approvalActionId, approvalToolName);

  // ─── P3: META_CONTROL 빈도 측정 ────────────────────────────────────────────
  state.permissionRequestCount += 1;

  // Fire-and-forget META_CONTROL signal (빈도 관찰 — 차단 경로 지연 최소화)
  if (config.dataSharing) {
    const signal = buildMetaControlSignal(state, session_id, config.frameworkTag ?? 'stable');
    client.sendCritical(signal).catch(() => {});

    // Breach Taxonomy: emit approval_requested observation signal
    const approvalSignal = buildApprovalSignal(state, session_id, {
      event_type: 'approval_requested',
      approval_action_id: approvalActionId,
      tool_name: approvalToolName,
      priority: 'normal',
    }, config.frameworkTag ?? 'stable');
    client.sendCritical(approvalSignal).catch(() => {});
  }

  if (config.debug) {
    process.stderr.write(
      `[P-MATRIX] PermissionRequest: count=${state.permissionRequestCount} session=${session_id}\n`
    );
  }

  // ─── Kill Switch ───────────────────────────────────────────────────────────
  const shouldHalt =
    state.isHalted || state.currentRt >= config.killSwitch.autoHaltOnRt;

  if (shouldHalt) {
    if (!state.isHalted) {
      state.isHalted = true;
      state.haltReason = `R(t) ${state.currentRt.toFixed(2)} ≥ ${config.killSwitch.autoHaltOnRt}`;
      state.dangerEvents += 1;
    }

    // Breach Taxonomy: permission denied at Kill Switch → approval_denied
    breachSupport.recordApprovalDenied(approvalActionId);
    breachSupport.saveState(session_id);
    if (config.dataSharing) {
      const deniedSignal = buildApprovalSignal(state, session_id, {
        event_type: 'approval_denied',
        approval_action_id: approvalActionId,
        tool_name: approvalToolName,
        priority: 'critical',
      }, config.frameworkTag ?? 'stable');
      client.sendCritical(deniedSignal).catch(() => {});
    }

    saveState(state);

    if (config.debug) {
      process.stderr.write(
        `[P-MATRIX] PermissionRequest DENIED + interrupt: R(t)=${state.currentRt.toFixed(3)}\n`
      );
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'deny',
          message: `P-MATRIX Kill Switch: R(t) ≥ ${config.killSwitch.autoHaltOnRt} — session halted`,
          interrupt: true,
        },
      },
    };
  }

  // Allow — Breach Taxonomy: permission allowed → approval_granted
  // NOTE: PermissionRequest fires when Claude shows the dialog.
  // If the hook returns 'allow', the dialog is shown and the user may still deny.
  // True approval_granted/denied from user response is tracked in pre-tool-use (allow)
  // and post-tool-use-failure (deny) respectively.
  breachSupport.recordApprovalGranted(approvalActionId);
  breachSupport.saveState(session_id);
  if (config.dataSharing) {
    const grantedSignal = buildApprovalSignal(state, session_id, {
      event_type: 'approval_granted',
      approval_action_id: approvalActionId,
      tool_name: approvalToolName,
      priority: 'normal',
    }, config.frameworkTag ?? 'stable');
    client.sendCritical(grantedSignal).catch(() => {});
  }

  saveState(state);

  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'allow',
      },
    },
  };
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function buildMetaControlSignal(
  state: ReturnType<typeof loadOrCreateState>,
  sessionId: string,
  frameworkTag: 'beta' | 'stable',
): SignalPayload {
  return {
    agent_id: state.agentId,
    // Neutral signal for non-measured axes — avoids all-zero → R(t)=0.745 HALT
    baseline: 0.5,
    norm: 0.5,
    stability: 0.5,
    // Small META_CONTROL nudge per permission request — 권한 경계 도달 빈도
    meta_control: 0.02,
    timestamp: new Date().toISOString(),
    signal_source: 'codex_hook',
    framework: 'codex',
    framework_tag: frameworkTag,
    schema_version: '0.3',
    metadata: {
      event_type: 'permission_request',
      session_id: sessionId,
      permission_request_count: state.permissionRequestCount,
      priority: 'normal',
    },
    state_vector: null,
  };
}

/** Breach Taxonomy: approval tracking signal (requested / granted / denied) */
function buildApprovalSignal(
  state: ReturnType<typeof loadOrCreateState>,
  sessionId: string,
  metadata: Record<string, unknown>,
  frameworkTag: 'beta' | 'stable',
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
      session_id: sessionId,
      ...metadata,
    },
    state_vector: null,
  };
}
