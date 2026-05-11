// =============================================================================
// @pmatrix/codex-monitor — hooks/user-prompt-submit.ts
// UserPromptSubmit hook handler
//
// P3 scope:
//   1. Credential scan — credential-scanner.ts 첫 실제 활성화
//      - prompt 원문을 스캔하되, 원문 자체는 서버에 전송하지 않음 (§5.4)
//      - Credential 감지 시: BLOCK (exit 2) + credential_type/count만 신호 전송
//   2. Prompt 제출 빈도 측정 (INIT 축)
//      - totalTurns 카운터 증가 (P1 리뷰 [1] 해결 — UserPromptSubmit이 실제 turn 경계)
//      - 빈도 신호 전송 (session_id + total_turns)
//
// Privacy-first:
//   - prompt 원문은 저장·전송하지 않음
//   - credential 감지 시에도 type/count만 전송, 매칭 문자열 미포함
// =============================================================================

import {
  PMatrixConfig,
  UserPromptSubmitInput,
  SignalPayload,
} from '../types';
import { PMatrixHttpClient } from '../client';
import {
  loadOrCreateState,
  saveState,
} from '../state-store';
import { scanCredentials } from '../credential-scanner';
import { isField4Enabled, writeFieldState } from '@pmatrix/field-node-runtime';

// ─── Handler result ───────────────────────────────────────────────────────────

interface UserPromptSubmitResult {
  /** true = block the prompt (index.ts calls process.exit(2)) */
  blocked: boolean;
  /** Error message written to stderr on block (shown to user by Claude Code) */
  reason?: string;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handleUserPromptSubmit(
  event: UserPromptSubmitInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient,
): Promise<UserPromptSubmitResult> {
  const { session_id, prompt } = event;

  const state = loadOrCreateState(session_id, config.agentId);

  // Track turn frequency — fixes P1 review item [1] (totalTurns always 0)
  // UserPromptSubmit is the canonical turn boundary in Claude Code sessions
  state.totalTurns += 1;

  // ─── Credential Protection ────────────────────────────────────────────────
  if (config.credentialProtection.enabled && prompt) {
    const hits = scanCredentials(prompt, config.credentialProtection.customPatterns);

    if (hits.length > 0) {
      state.credentialBlocks += 1;
      state.dangerEvents += 1;

      const credentialTypes = hits.map(h => h.name).join(', ');
      const totalCount = hits.reduce((sum, h) => sum + h.count, 0);

      if (config.debug) {
        process.stderr.write(
          `[P-MATRIX] UserPromptSubmit: credential detected — ${credentialTypes} (count=${totalCount})\n`
        );
      }

      // Alert signal: type/count only — prompt content NOT included (§5.4)
      if (config.dataSharing) {
        const signal = buildCredentialAlertSignal(state, session_id, totalCount, credentialTypes, config.frameworkTag ?? 'stable');
        client.sendCritical(signal).catch(() => {});
      }

      saveState(state);

      return {
        blocked: true,
        reason: `[P-MATRIX] Credential detected in prompt (${credentialTypes}).\nPlease remove sensitive data before submitting.\n`,
      };
    }
  }

  // ─── Frequency Signal (INIT axis) ────────────────────────────────────────
  if (config.dataSharing) {
    const signal = buildFrequencySignal(state, session_id, config.frameworkTag ?? 'stable');
    client.sendCritical(signal).catch(() => {});
  }

  if (config.debug) {
    process.stderr.write(
      `[P-MATRIX] UserPromptSubmit: turn=${state.totalTurns} session=${session_id}\n`
    );
  }

  saveState(state);

  // 4.0 Field IPC: write axes for MCP poller
  if (isField4Enabled()) {
    writeFieldState(session_id, {
      currentRt: state.currentRt,
      currentMode: state.currentMode,
      totalTurns: state.totalTurns,
    });
  }

  return { blocked: false };
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function buildCredentialAlertSignal(
  state: ReturnType<typeof loadOrCreateState>,
  sessionId: string,
  credentialCount: number,
  credentialTypes: string,
  frameworkTag: 'beta' | 'stable',
): SignalPayload {
  return {
    agent_id: state.agentId,
    baseline: 0.5,
    norm: 0.5,
    // Credential in prompt = significant stability concern (low stability = higher risk)
    stability: 0.10,
    meta_control: 0.5,
    timestamp: new Date().toISOString(),
    signal_source: 'codex_hook',
    framework: 'codex',
    framework_tag: frameworkTag,
    schema_version: '0.3',
    metadata: {
      event_type: 'credential_detected',
      session_id: sessionId,
      credential_count: credentialCount,
      // credential_types = pattern names only (e.g., "Anthropic Key") — never matched values
      credential_types: credentialTypes,
      priority: 'critical',
    },
    state_vector: null,
  };
}

function buildFrequencySignal(
  state: ReturnType<typeof loadOrCreateState>,
  sessionId: string,
  frameworkTag: 'beta' | 'stable',
): SignalPayload {
  return {
    agent_id: state.agentId,
    // Neutral signal — avoids all-zero → R(t)=0.75 HALT
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
      event_type: 'prompt_submit',
      session_id: sessionId,
      total_turns: state.totalTurns,
      priority: 'normal',
    },
    state_vector: null,
  };
}
