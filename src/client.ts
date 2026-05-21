// =============================================================================
// @pmatrix/codex-monitor — client.ts
// =============================================================================
// R-X.3 migration: PMatrixHttpClient extracted to @pmatrix/core-sdk v0.1.0.
// This file is a thin Codex-bound wrapper pre-supplying AdapterIdentity.
// Downstream hook code instantiates with PMatrixConfig only.
// =============================================================================

import { PMatrixHttpClient as CorePMatrixHttpClient } from '@pmatrix/core-sdk';
import type {
  AdapterIdentity,
  PMatrixConfig,
} from '@pmatrix/core-sdk';

export type { SessionSummaryInput } from '@pmatrix/core-sdk';

const CODEX_IDENTITY: AdapterIdentity = Object.freeze({
  signalSource: 'codex_hook',
  framework: 'codex',
});

export class PMatrixHttpClient extends CorePMatrixHttpClient {
  constructor(config: PMatrixConfig) {
    super(config, CODEX_IDENTITY);
  }
}
