// =============================================================================
// @pmatrix/codex-monitor — hooks/pre-tool-use.ts
// PreToolUse hook handler — Safety Gate core
//
// Flow:
//   1. Load session state (or fail-open default)
//   2. Check isHalted → BLOCK immediately
//   3. Classify tool risk (tool_name only — no tool_input content)
//   4. Check meta-control rules (tool_name only)
//   5. Send signal to server with serverTimeoutMs fail-open
//   6. Update R(t) cache in state
//   7. Evaluate safety gate → ALLOW or BLOCK
//   8. Return PreToolUseOutput JSON
// =============================================================================

import { PMatrixConfig, PreToolUseInput, PreToolUseOutput, SignalPayload } from '../types';
import { PMatrixHttpClient } from '../client';
import {
  classifyToolRisk,
  evaluateSafetyGate,
  checkMetaControlRules,
  rtToMode,
} from '../safety-gate';
import {
  loadOrCreateState,
  saveState,
  buildRtCacheExpiry,
  isRtCacheValid,
  isHaltActive,
  PersistedSessionState,
} from '../state-store';
import { isField4Enabled, writeFieldState } from '@pmatrix/field-node-runtime';
import { BreachSupport } from '../breach-support';

/** Write field state partial for MCP IPC poller (fail-open, no-op if 4.0 not enabled) */
function syncFieldState(sessionId: string, state: PersistedSessionState): void {
  if (!isField4Enabled()) return;
  writeFieldState(sessionId, {
    currentRt: state.currentRt,
    currentMode: state.currentMode,
    totalTurns: state.totalTurns,
  });
}

export async function handlePreToolUse(
  event: PreToolUseInput,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<PreToolUseOutput> {
  const { session_id, tool_name } = event;
  const agentId = config.agentId;

  // ① HALT file check — global Kill Switch, checked before ANY state load
  // ~/.pmatrix/HALT presence → block immediately, no state I/O
  if (isHaltActive()) {
    return buildDenyOutput(
      'P-MATRIX Kill Switch HALT active. All tool calls blocked. Remove ~/.pmatrix/HALT to resume.'
    );
  }

  // Safety Gate disabled — allow, but still run credential protection + dataSharing
  // (those are controlled by their own flags; safetyGate.enabled is gate-only)
  if (!config.safetyGate.enabled) {
    return buildAllowOutput();
  }

  // 1. Load state (fail-open: createDefault if missing)
  const state = loadOrCreateState(session_id, agentId);

  // Breach Taxonomy support — load persisted state (hook runs as new process)
  const breachSupport = BreachSupport.loadOrCreate(agentId, session_id);
  breachSupport.incrementToolCalls();
  state.totalTurns += 1;

  // 2. Kill Switch: halted sessions block everything
  if (state.isHalted) {
    const output = buildDenyOutput(
      `P-MATRIX Kill Switch active: ${state.haltReason ?? 'R(t) ≥ 0.75'}`
    );
    // persist safetyGateBlocks increment
    state.safetyGateBlocks += 1;
    breachSupport.saveState(session_id);
    saveState(state);
    return output;
  }

  // 3. Tool risk classification (tool_name only — privacy-first, no tool_input)
  const toolRisk = classifyToolRisk(
    tool_name,
    config.safetyGate.customToolRisk
  );

  // 4. meta_control special rules
  // DISABLED_BY_DESIGN: privacy-first. tool_input not available in Claude Code hooks.
  // Enable per-platform where tool_input is provided (e.g., Cursor beforeShellExecution).
  // META_CONTROL_RULES regex patterns (sudo/rm-rf/curl|sh) need command text in params.
  // With params=null, only tool_name itself matches — insufficient coverage.
  const META_CONTROL_RULES_ENABLED = false;
  const mcBlock = META_CONTROL_RULES_ENABLED ? checkMetaControlRules(tool_name, null) : null;
  if (mcBlock !== null) {
    // Send critical signal (fire-and-forget, no await needed for response)
    const criticalSignal = buildSignal(state, session_id, tool_name, {
      event_type: 'meta_control_block',
      priority: 'critical',
      meta_control_delta: mcBlock.metaControlDelta,
    }, config.frameworkTag ?? 'stable', 0.05);
    client.sendCritical(criticalSignal).catch(() => {});

    state.dangerEvents += 1;
    state.safetyGateBlocks += 1;
    breachSupport.recordBlockedAction(tool_name, mcBlock.reason);
    breachSupport.incrementDenied();
    breachSupport.saveState(session_id);
    saveState(state);

    return buildDenyOutput(`P-MATRIX Safety Gate: ${mcBlock.reason}`);
  }

  // 5. Get R(t) from server (with fail-open timeout)
  const rt = await fetchRtWithFailOpen(state, session_id, tool_name, config, client, breachSupport);

  // 6. Evaluate safety gate
  const gateResult = evaluateSafetyGate(rt, toolRisk);

  if (gateResult.action === 'BLOCK') {
    // Send signal recording the block
    const blockSignal = buildSignal(state, session_id, tool_name, {
      event_type: 'safety_gate_block',
      priority: 'critical',
    }, config.frameworkTag ?? 'stable', 0.05);
    client.sendCritical(blockSignal).catch(() => {});

    state.safetyGateBlocks += 1;
    state.dangerEvents += 1;  // safety gate block is a danger event
    breachSupport.recordBlockedAction(tool_name, gateResult.reason);
    breachSupport.incrementDenied();
    if (rt >= config.killSwitch.autoHaltOnRt) {
      state.isHalted = true;
      state.haltReason = `R(t) ${rt.toFixed(2)} ≥ ${config.killSwitch.autoHaltOnRt}`;
    }
    breachSupport.saveState(session_id);
    saveState(state);

    return buildDenyOutput(`P-MATRIX Safety Gate: ${gateResult.reason}`);
  }

  // ALLOW
  breachSupport.saveState(session_id);
  saveState(state);
  syncFieldState(session_id, state);
  return buildAllowOutput();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fetch R(t) from server with fail-open timeout.
 * If server call exceeds serverTimeoutMs or fails → return cached R(t).
 * This is the core fail-open guarantee: server issues never block Claude Code.
 */
async function fetchRtWithFailOpen(
  state: PersistedSessionState,
  sessionId: string,
  toolName: string,
  config: PMatrixConfig,
  client: PMatrixHttpClient,
  breachSupport: BreachSupport,
): Promise<number> {
  // If cache is valid, use it (skip server call)
  if (isRtCacheValid(state)) {
    return state.currentRt;
  }

  const signal = buildSignal(state, sessionId, toolName, {
    event_type: 'pre_tool_use',
    priority: 'normal',
    in_scope: breachSupport.isInScope(toolName),
  }, config.frameworkTag ?? 'stable');

  try {
    const response = await withTimeout(
      client.sendSignal(signal),
      config.safetyGate.serverTimeoutMs
    );

    const rtData = PMatrixHttpClient.extractRtFromResponse(response);
    if (rtData) {
      state.currentRt = rtData.rt;
      state.currentMode = rtData.mode;
      state.grade = rtData.grade;
      state.rtCacheExpiry = buildRtCacheExpiry();

      if (config.debug) {
        process.stderr.write(
          `[P-MATRIX] R(t)=${rtData.rt.toFixed(3)} mode=${rtData.mode} grade=${rtData.grade}\n`
        );
      }
    }
  } catch {
    // fail-open: use cached/default R(t), do not block
    if (config.debug) {
      process.stderr.write(
        `[P-MATRIX] Server call failed/timeout — fail-open, using cached R(t)=${state.currentRt.toFixed(3)}\n`
      );
    }
  }

  return state.currentRt;
}

function buildSignal(
  state: PersistedSessionState,
  sessionId: string,
  toolName: string,
  metadata: Record<string, unknown>,
  frameworkTag: 'beta' | 'stable',
  normDelta: number = 0.0,
): SignalPayload {
  return {
    agent_id: state.agentId,
    baseline: 0.5,
    // event-based fixed delta — deny=0.05, allow/observe=0.0
    // Replaces state.currentRt to break positive feedback loop
    norm: normDelta,
    stability: 0.5,
    meta_control: 0.5,
    timestamp: new Date().toISOString(),
    signal_source: 'codex_hook',
    framework: 'codex',
    framework_tag: frameworkTag,
    schema_version: '0.3',
    metadata: {
      session_id: sessionId,
      tool_name: toolName,
      ...metadata,
    },
    state_vector: null,
  };
}

function buildAllowOutput(): PreToolUseOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    },
  };
}

function buildDenyOutput(reason: string): PreToolUseOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout after ${ms}ms`)),
      ms
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}
