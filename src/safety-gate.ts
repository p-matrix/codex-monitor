// =============================================================================
// @pmatrix/claude-code-monitor — safety-gate.ts
// Safety Gate pure logic — 100% reuse from @pmatrix/openclaw-monitor
// (Only import source changed — types.ts path)
// =============================================================================

import { ToolRiskTier, GateAction, SafetyMode } from './types';

// ─── R(t) → Mode boundaries (Server constants.py, §14-4) ─────────────────────

export function rtToMode(rt: number): SafetyMode {
  if (rt < 0.15) return 'normal';
  if (rt < 0.30) return 'caution';
  if (rt < 0.50) return 'alert';
  if (rt < 0.75) return 'critical';
  return 'halt';
}

// ─── Tool Risk Tier classification (§3-1) ─────────────────────────────────────

const HIGH_RISK_TOOLS = new Set([
  'exec',
  'bash',
  'shell',
  'run',
  'apply_patch',
  'browser',
  'computer',
  'terminal',
  'code_interpreter',
  'write',         // Claude Code: Write tool (file creation)
  'edit',          // Claude Code: Edit tool (file modification)
  'multiedit',     // Claude Code: MultiEdit
]);

const MEDIUM_RISK_TOOLS = new Set([
  'web_fetch',
  'http_request',
  'fetch',
  'request',
  'curl',
  'wget',
  'webfetch',      // Claude Code: WebFetch tool
  'websearch',     // Claude Code: WebSearch tool
  'task',          // Claude Code: Task (subagent spawning)
]);

const LOW_TOOL_PREFIXES = [
  'pmatrix_',
  'file_read',
  'list_files',
  'search',
  'read',
  'glob',
  'grep',
  'ls',
  'find',
  'cat',
  'head',
  'tail',
  'todoread',
  'todowrite',
];

export function classifyToolRisk(
  toolName: string,
  customToolRisk?: Record<string, ToolRiskTier>
): ToolRiskTier {
  if (customToolRisk) {
    const custom = customToolRisk[toolName];
    if (custom) return custom;
  }

  const lower = toolName.toLowerCase();

  if (HIGH_RISK_TOOLS.has(lower)) return 'HIGH';
  if (MEDIUM_RISK_TOOLS.has(lower)) return 'MEDIUM';

  if (LOW_TOOL_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return 'LOW';
  }

  return 'MEDIUM';  // conservative default
}

// ─── Safety Gate matrix (§3-1) ────────────────────────────────────────────────

interface GateResult {
  action: GateAction;
  reason: string;
}

/**
 * Safety Gate 판정 매트릭스 (§3-1)
 *
 * | R(t)       | Mode     | HIGH    | MEDIUM  | LOW   |
 * |------------|----------|---------|---------|-------|
 * | < 0.15     | Normal   | ALLOW   | ALLOW   | ALLOW |
 * | 0.15~0.30  | Caution  | BLOCK   | ALLOW   | ALLOW |
 * | 0.30~0.50  | Alert    | BLOCK   | ALLOW   | ALLOW |
 * | 0.50~0.75  | Critical | BLOCK   | BLOCK   | ALLOW |
 * | ≥ 0.75     | Halt     | BLOCK   | BLOCK   | BLOCK |
 *
 * Claude Code 차이: CONFIRM 없음 (동기 확인 UX 불가) → CONFIRM → BLOCK으로 격상
 */
export function evaluateSafetyGate(
  rt: number,
  toolRisk: ToolRiskTier
): GateResult {
  const mode = rtToMode(rt);
  const rtStr = rt.toFixed(2);

  if (mode === 'halt') {
    return {
      action: 'BLOCK',
      reason: `HALT: R(t) ${rtStr} ≥ 0.75 — all tools blocked`,
    };
  }

  if (mode === 'critical') {
    if (toolRisk === 'HIGH' || toolRisk === 'MEDIUM') {
      return {
        action: 'BLOCK',
        reason: `Critical zone R(t) ${rtStr} — ${toolRisk.toLowerCase()}-risk tool blocked`,
      };
    }
    return { action: 'ALLOW', reason: '' };
  }

  if (mode === 'alert' || mode === 'caution') {
    if (toolRisk === 'HIGH') {
      return {
        action: 'BLOCK',
        reason: `Elevated R(t) ${rtStr} — high-risk tool blocked`,
      };
    }
    return { action: 'ALLOW', reason: '' };
  }

  return { action: 'ALLOW', reason: '' };
}

// ─── meta_control special rules (§3-1) ───────────────────────────────────────

interface MetaControlBlockResult {
  reason: string;
  metaControlDelta: number;
}

interface MetaControlRule {
  pattern: RegExp;
  reason: string;
  metaControlDelta: number;
}

const META_CONTROL_RULES: readonly MetaControlRule[] = [
  {
    pattern: /\bsudo\b|chmod\s+777/i,
    reason: 'Privilege escalation attempt detected (sudo / chmod 777)',
    metaControlDelta: -0.25,
  },
  {
    pattern: /rm\s+-rf\s+(\/(?!tmp|var\/tmp)[^\s]*|~)/i,
    reason: 'Destructive deletion detected (rm -rf)',
    metaControlDelta: -0.30,
  },
  {
    pattern: /(?:curl|wget)\s+[^\|]+\|\s*(?:ba)?sh\b/i,
    reason: 'Remote code execution pattern detected (curl/wget | sh)',
    metaControlDelta: -0.20,
  },
  {
    pattern: /base64\s+(?:--decode|-d)\s+.*\|\s*(?:ba)?sh\b/i,
    reason: 'Obfuscated RCE pattern (base64 decode | sh)',
    metaControlDelta: -0.25,
  },
  {
    pattern: /chmod\s+777\s+\//i,
    reason: 'Dangerous permission change (chmod 777 /)',
    metaControlDelta: -0.15,
  },
] as const;

export function checkMetaControlRules(
  toolName: string,
  params: unknown
): MetaControlBlockResult | null {
  const paramsStr = serializeParams(params);
  const combined = `${toolName} ${paramsStr}`;

  for (const rule of META_CONTROL_RULES) {
    if (rule.pattern.test(combined)) {
      return {
        reason: rule.reason,
        metaControlDelta: rule.metaControlDelta,
      };
    }
  }

  return null;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function serializeParams(params: unknown): string {
  if (params == null) return '';
  if (typeof params === 'string') return params;
  try {
    return JSON.stringify(params);
  } catch {
    return String(params);
  }
}

