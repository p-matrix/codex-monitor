// =============================================================================
// state-store.ts — Re-export from @pmatrix/core-sdk (A19-3 extract, Family A)
// =============================================================================
// Previously duplicated across 3 SDK (cc/codex/hermes = 366 LOC × 3 = 1,098 LOC,
// pairwise diff = brand strings only). Now unified in @pmatrix/core-sdk.
// Framework string ('codex') pre-bound at this wrapper.
// =============================================================================

import * as Core from '@pmatrix/core-sdk';

const FRAMEWORK = 'codex';

// Direct re-exports (framework-independent)
export {
  TOOL_DURATIONS_MAX,
  isRtCacheValid,
  buildRtCacheExpiry,
  loadState,
  pushToolDuration,
  saveState,
  deleteState,
  haltFilePath,
  isHaltActive,
  activateHalt,
  cleanupStaleStates,
} from '@pmatrix/core-sdk';
export type { PersistedSessionState } from '@pmatrix/core-sdk';

// Framework-bound wrappers
export function createDefaultState(sessionId: string, agentId: string) {
  return Core.createDefaultState(sessionId, agentId, FRAMEWORK);
}

export function loadOrCreateState(sessionId: string, agentId: string) {
  return Core.loadOrCreateState(sessionId, agentId, FRAMEWORK);
}

export function findActiveSession(framework?: string) {
  return Core.findActiveSession(framework ?? FRAMEWORK);
}
