// =============================================================================
// @pmatrix/codex-monitor — types.ts
// Codex CLI hook input/output types + P-MATRIX shared types
//
// Sources:
//   - Codex CLI official hooks reference (developers.openai.com/codex/hooks)
//   - PMATRIX_CODEX_MONITOR_v1_0_PRODUCT_SPEC.md
//   - Sub-set of claude-code-monitor types (6/19 hooks)
// =============================================================================

// ─── Codex CLI Hook Input (stdin JSON) ──────────────────────────────────────

/** Common payload fields (all events) */
interface CodexHookCommon {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name: string;
  model?: string;
  /** turn-scoped events only (PreToolUse, PostToolUse, Stop) */
  turn_id?: string;
}

/**
 * SessionStart hook input — session bootstrap (or resume)
 * Observation only (no blocking)
 */
export interface SessionStartInput extends CodexHookCommon {
  hook_event_name: 'SessionStart';
  source?: string;
}

/**
 * UserPromptSubmit hook input — user input submitted
 * Privacy-first: prompt content scanned but NOT stored or forwarded (§5.4)
 * Can block (exit 2) on credential detection
 */
export interface UserPromptSubmitInput extends CodexHookCommon {
  hook_event_name: 'UserPromptSubmit';
  /** User's prompt text — scanned for credentials, NOT stored or forwarded */
  prompt?: string;
}

/**
 * PreToolUse hook input — Safety Gate core
 * tool_name: 'Bash' | 'apply_patch' | 'mcp__<server>__<tool>' | 'Edit' | 'Write'
 * Privacy-first: tool_input content NOT used (§5.4)
 */
export interface PreToolUseInput extends CodexHookCommon {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_use_id?: string;
  /** tool_input exists but P-MATRIX does NOT read content — privacy policy */
  tool_input?: Record<string, unknown>;
}

/**
 * PermissionRequest hook input — approval workflow
 */
export interface PermissionRequestInput extends CodexHookCommon {
  hook_event_name: 'PermissionRequest';
  tool_name?: string;
  permission?: Record<string, unknown>;
}

/**
 * PostToolUse hook input — observation + apply_patch AP-2
 * duration_ms: tool execution latency
 * tool_input.path: extracted for AP-2 file_write event (apply_patch only)
 */
export interface PostToolUseInput extends CodexHookCommon {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_use_id?: string;
  /** Tool execution latency in ms */
  duration_ms?: number;
  /** apply_patch metadata — file_path extracted from tool_input.path or matchers */
  tool_input?: Record<string, unknown>;
}

/**
 * Stop hook input — turn end
 * Trigger session_report + breach flush
 */
export interface StopInput extends CodexHookCommon {
  hook_event_name: 'Stop';
  end_reason?: string;
  duration_ms?: number;
}

/** Union of all Codex hook inputs */
export type CodexHookInput =
  | SessionStartInput
  | UserPromptSubmitInput
  | PreToolUseInput
  | PermissionRequestInput
  | PostToolUseInput
  | StopInput;

// ─── Codex Hook Output (stdout JSON) ────────────────────────────────────────

/**
 * PreToolUse output — written to stdout
 * Codex CLI: hookSpecificOutput.permissionDecision (allow/deny/ask)
 */
export interface PreToolUseOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
}

/**
 * PermissionRequest output — written to stdout
 */
export interface PermissionRequestOutput {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest';
    decision: {
      behavior: 'allow' | 'deny';
      message?: string;
      /** true = Kill Switch: forces session abort */
      interrupt?: boolean;
    };
  };
}

/**
 * Generic Codex hook output (continue / stopReason / systemMessage)
 * For non-blocking hooks (PostToolUse, SessionStart, Stop, etc.)
 */
export interface GenericCodexOutput {
  continue?: boolean;
  stopReason?: string;
  systemMessage?: string;
}

// ─── Re-export shared types from @pmatrix/core-sdk (R-X.3 migration) ──────

export type {
  SafetyMode,
  TrustGrade,
  ToolRiskTier,
  GateAction,
  AxesState,
} from '@pmatrix/core-sdk';

import type { SignalPayload as CoreSignalPayload } from '@pmatrix/core-sdk';

// ─── Codex-narrowed SignalPayload ──────────────────────────────────────────
//
// Core-SDK SignalPayload uses signal_source: string + framework: string.
// Codex-monitor narrows to literals so hook code's hardcoded 'codex_hook' /
// 'codex' continues to type-check. Narrowed = structural subtype of core's
// generic, PMatrixHttpClient.sendBatch accepts via TypeScript structural typing.
//
// Server-side framework enum: claude_code | openclaw | cursor | gemini | codex | hermes

export interface SignalPayload extends Omit<CoreSignalPayload, 'signal_source' | 'framework'> {
  signal_source: 'codex_hook';
  framework: 'codex';
}

export interface SignalMetadata {
  session_id?: string;
  event_type?: string;
  tool_name?: string;
  priority?: 'critical' | 'normal';
  meta_control_delta?: number;
  baseline_delta?: number;
  danger_events?: number;
  credential_blocks?: number;
  safety_gate_blocks?: number;
  total_turns?: number;
  end_reason?: string;
  is_halted?: boolean;
  /** apply_patch AP-2 — file_path */
  file_path?: string;
  /** apply_patch AP-2 — in_scope flag */
  in_scope?: boolean;
  /** apply_patch AP-2 — action_primitive (always 'AP-2' for file_write) */
  action_primitive?: string;
  /** PostToolUse — tool execution latency */
  duration_ms?: number;
  [key: string]: unknown;
}

// ─── API Response + Config types (re-exported from @pmatrix/core-sdk) ─────

export type {
  BatchSendResponse,
  GradeResponse,
  AgentGradeHistoryItem,
  AgentGradeDetail,
  SafetyGateConfig,
  CredentialProtectionConfig,
  KillSwitchConfig,
  BatchConfig,
  PMatrixConfig,
} from '@pmatrix/core-sdk';
