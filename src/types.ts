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

// ─── 5-Mode and Grade ───────────────────────────────────────────────────────

/** P-MATRIX 5-Mode (Server constants.py 경계값 기준) */
export type SafetyMode = 'normal' | 'caution' | 'alert' | 'critical' | 'halt';

/** Trust Grade */
export type TrustGrade = 'A' | 'B' | 'C' | 'D' | 'E';

/** Tool risk tier */
export type ToolRiskTier = 'HIGH' | 'MEDIUM' | 'LOW';

/** Safety Gate action */
export type GateAction = 'ALLOW' | 'BLOCK';

// ─── 4-axis state ───────────────────────────────────────────────────────────
//
// Stability axis polarity convention:
//   Monitor sends "instability" — higher value = more unstable (0=safe, 1.0=HALT).
//   Server inverts stability for R(t) computation.
//

export interface AxesState {
  baseline: number;
  norm: number;
  /** Instability score: 0=stable, 1.0=maximum instability */
  stability: number;
  meta_control: number;
}

// ─── Signal Payload (POST /v1/inspect/stream) ───────────────────────────────

/**
 * POST /v1/inspect/stream payload — codex_hook variant
 * signal_source: 'codex_hook', framework: 'codex'
 *
 * Server-side framework enum: claude_code | openclaw | cursor | gemini | codex
 * (Codex 추가는 Lockstep Protocol §6.5 첫 적용 사례, lesson 100 official)
 */
export interface SignalPayload {
  agent_id: string;
  baseline: number;
  norm: number;
  stability: number;
  meta_control: number;
  timestamp: string;
  signal_source: 'codex_hook';
  framework: 'codex';
  framework_tag: 'beta' | 'stable';
  schema_version: '0.3';
  metadata: SignalMetadata;
  state_vector: null;
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

// ─── API Response types (CC 와 동일) ────────────────────────────────────────

export interface BatchSendResponse {
  received: number;
  risk?: number;
  grade?: TrustGrade;
  mode?: SafetyMode;
  axes?: {
    baseline: number;
    norm: number;
    stability: number;
    meta_control: number;
  };
}

export interface GradeResponse {
  agent_id: string;
  grade: TrustGrade;
  p_score: number;
  risk: number;
  mode: SafetyMode;
  axes: {
    baseline: number;
    norm: number;
    stability: number;
    meta_control: number;
  };
  last_updated: string;
}

export interface AgentGradeHistoryItem {
  grade: TrustGrade;
  p_score: number;
  completed_at: string;
}

export interface AgentGradeDetail {
  current_grade: TrustGrade | null;
  p_score: number | null;
  issued_at: string | null;
  expires_at: string | null;
  prev_grade: TrustGrade | null;
  prev_p_score: number | null;
  history: AgentGradeHistoryItem[];
}

// ─── Config types (CC 와 동일) ──────────────────────────────────────────────

export interface SafetyGateConfig {
  enabled: boolean;
  /** Server call timeout (ms). fail-open: >2500ms → PERMIT */
  serverTimeoutMs: number;
  customToolRisk?: Record<string, ToolRiskTier>;
}

export interface CredentialProtectionConfig {
  enabled: boolean;
  customPatterns: string[];
}

export interface KillSwitchConfig {
  /** R(t) ≥ this value → auto Halt (default 0.75) */
  autoHaltOnRt: number;
}

export interface BatchConfig {
  maxSize: number;
  flushIntervalMs: number;
  retryMax: number;
}

export interface PMatrixConfig {
  serverUrl: string;
  agentId: string;
  apiKey: string;
  safetyGate: SafetyGateConfig;
  credentialProtection: CredentialProtectionConfig;
  killSwitch: KillSwitchConfig;
  dataSharing: boolean;
  agreedAt?: string;
  batch: BatchConfig;
  frameworkTag?: 'beta' | 'stable';
  debug: boolean;
}
