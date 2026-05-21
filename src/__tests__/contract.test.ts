// =============================================================================
// codex-monitor contract.test.ts — Tier 2 conformance (Contract v0.1)
// =============================================================================
// Validates codex-monitor emits Contract v0.1-conformant events through
// @pmatrix/core-sdk schemas. Tier 2 of the 3-tier conformance design.
// =============================================================================

import {
  AgentEventSchema,
  NormalizedActionEventSchema,
  ObservableFactSchema,
  AxisEvidenceSchema,
  PEPEvaluationInputSchema,
  type AgentEvent,
  type NormalizedActionEvent,
  type ObservableFact,
  type AxisEvidence,
  type PEPEvaluationInput,
} from '@pmatrix/core-sdk';
import { PMatrixHttpClient } from '../client';
import type { SessionSummaryInput } from '../client';
import type { PMatrixConfig } from '@pmatrix/core-sdk';

function mockConfig(): PMatrixConfig {
  return {
    serverUrl: 'https://test.invalid',
    agentId: 'codex-agent-001',
    apiKey: 'test-key',
    safetyGate: { enabled: true, serverTimeoutMs: 2500 },
    credentialProtection: { enabled: true, customPatterns: [] },
    killSwitch: { autoHaltOnRt: 0.75 },
    dataSharing: false,
    batch: { maxSize: 50, flushIntervalMs: 5000, retryMax: 3 },
    debug: false,
  };
}

function codexAgentEvent(eventType: string, hookName: string): AgentEvent {
  return {
    vendor: 'openai',
    product: 'codex-cli',
    host_surface: 'cli',
    event_type: eventType,
    timestamp: '2026-05-20T00:00:00.000Z',
    session_id: 'sess-codex-001',
    agent_id: 'codex-agent-001',
    raw_event_ref: 'sha256:codex-raw-event',
    content_included: false,
    host_integration_scope: {
      integration_type: 'cli-hook',
      hook_name: hookName,
      adapter_version: '0.1.0',
    },
    vendor_extensions: { model: 'gpt-5-codex' },
  };
}

describe('codex-monitor contract v0.1 conformance', () => {
  test('PMatrixHttpClient identity auto-injected (codex_hook / codex)', () => {
    const client = new PMatrixHttpClient(mockConfig());
    expect(client.identity.signalSource).toBe('codex_hook');
    expect(client.identity.framework).toBe('codex');
  });

  test('SessionSummaryInput drops hardcoded brand fields (R-X.3)', () => {
    const summary: SessionSummaryInput = {
      sessionId: 'sess-001',
      agentId: 'codex-agent-001',
      totalTurns: 5,
      dangerEvents: 0,
      credentialBlocks: 0,
      safetyGateBlocks: 0,
      framework_tag: 'stable',
    };
    expect(Object.prototype.hasOwnProperty.call(summary, 'signal_source')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(summary, 'framework')).toBe(false);
  });

  test.each([
    ['SessionStart', 'SessionStart'],
    ['UserPromptSubmit', 'UserPromptSubmit'],
    ['PreToolUse', 'PreToolUse'],
    ['PermissionRequest', 'PermissionRequest'],
    ['PostToolUse', 'PostToolUse'],
    ['Stop', 'Stop'],
  ])('emits valid AgentEvent for %s hook', (eventType, hookName) => {
    const ev = codexAgentEvent(eventType, hookName);
    expect(AgentEventSchema.safeParse(ev).success).toBe(true);
  });

  test('vendor_extensions accepts Codex-specific primitives', () => {
    const ev = codexAgentEvent('PreToolUse', 'PreToolUse');
    ev.vendor_extensions = {
      model: 'gpt-5-codex',
      turn_id: 'turn-001',
      action_primitive: 'AP-2',
      duration_ms: 142,
      in_scope: true,
    };
    expect(AgentEventSchema.safeParse(ev).success).toBe(true);
  });

  test('rejects content_included: true (content-agnostic invariant)', () => {
    const ev = codexAgentEvent('UserPromptSubmit', 'UserPromptSubmit');
    (ev as unknown as Record<string, unknown>)['content_included'] = true;
    expect(AgentEventSchema.safeParse(ev).success).toBe(false);
  });

  test('5-layer round-trip produces valid PEPEvaluationInput', () => {
    const agentEvent: AgentEvent = codexAgentEvent('PreToolUse', 'PreToolUse');
    expect(AgentEventSchema.safeParse(agentEvent).success).toBe(true);

    const normalized: NormalizedActionEvent = {
      source_event_ref: agentEvent.raw_event_ref,
      action_type: 'tool_call',
      actor: agentEvent.agent_id,
      target: 'apply_patch',
      scope: { delegation_ref: 'sha256:codex-delegation' },
      action_category: 'fs-write',
      evidence_ref: 'sha256:codex-patch-evidence',
    };
    expect(NormalizedActionEventSchema.safeParse(normalized).success).toBe(true);

    const fact: ObservableFact = {
      fact_type: 'action',
      fact_id: 'fact-codex-001',
      agent_id: agentEvent.agent_id,
      contract_id: 'contract-codex-001',
      source_vendor: agentEvent.vendor,
      source_surface: agentEvent.host_surface,
      observed_at: agentEvent.timestamp,
      confidence: 0.92,
      provenance: {
        adapter_id: 'codex-monitor-001',
        adapter_version: '0.1.0',
        chain_ref: null,
        signature: 'hmac-sha256:codex-sig',
      },
      content_agnostic_ref: 'sha256:fact-canonical',
      normalized_action_ref: normalized.source_event_ref,
    };
    expect(ObservableFactSchema.safeParse(fact).success).toBe(true);

    const evidence: AxisEvidence = {
      axis: 'baseline',
      evidence_type: 'observation',
      signal_strength: 0.2,
      direction: 'neutral',
      confidence: 0.9,
      reason_code: 'in_scope_patch_modification',
      fact_refs: [fact.fact_id],
      axis_status: 'PASS',
      axis_details: 'apply_patch within delegation scope',
    };
    expect(AxisEvidenceSchema.safeParse(evidence).success).toBe(true);

    const pepInput: PEPEvaluationInput = {
      delegation_contract_ref: normalized.scope.delegation_ref ?? null,
      current_runtime_mode: 'Normal',
      current_rt: 0.15,
      current_tier: 'T5',
      action_type: 'tool_call',
      action_category: 'fs-write',
      authority_scope: 'patch_apply',
      approval_requirement: 'auto',
      risk_level: 'low',
      fact_refs: [fact.fact_id],
      peer_verifications: [
        {
          peer_node_id: 'peer-alpha',
          decision: 'PASS',
          axes_status: {
            cap_within_bounds: 'PASS',
            delegation_receipt_valid: 'PASS',
            expiry_not_passed: 'PASS',
            action_within_scope: 'PASS',
            delegator_authority: 'PASS',
            policy_digest_match: 'PASS',
            rt_within_threshold: 'PASS',
            mode_compatible: 'PASS',
          },
          signature: 'hmac-sha256:peer-codex',
          timestamp: agentEvent.timestamp,
        },
      ],
      quorum_rule: 'critical-axis-veto',
    };
    expect(PEPEvaluationInputSchema.safeParse(pepInput).success).toBe(true);
  });
});
