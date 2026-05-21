// =============================================================================
// @pmatrix/codex-monitor — safety-gate.ts (thin re-export)
// =============================================================================
// A19-4 extract (Week 21 weekly-code-review): cc/codex pair were 100% identical
// → consolidated to @pmatrix/core-sdk/safety-gate. Other 4 SDK retain own
// variants (architectural diff per host integration surface).
// =============================================================================

export {
  rtToMode,
  classifyToolRisk,
  evaluateSafetyGate,
  checkMetaControlRules,
} from '@pmatrix/core-sdk';
export type { GateResult, MetaControlBlockResult } from '@pmatrix/core-sdk';
