// =============================================================================
// @pmatrix/claude-code-monitor — state-store.ts
// File-based session state persistence
//
// NEW module — no OpenClaw equivalent.
// Each Claude Code hook invocation is a new process; in-memory state does not
// persist between calls. This module provides read/write to
// ~/.pmatrix/sessions/{session_id}.json for cross-invocation continuity.
//
// Design:
//   - Sync I/O only (hook invocations are short-lived, no event loop concern)
//   - Atomic write: write to temp file then rename
//   - Fail-open: any I/O error → return default state, never throw
//   - Cleanup: sessions older than SESSION_TTL_MS are removed on load
//
// KNOWN_LIMITATION: No file lock. Concurrent access mitigated by atomic write
// (temp→rename) + fail-open. Multi-monitor (3+) scenarios may increase collision
// probability. Monitor via corrupted-state log.
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SafetyMode, TrustGrade } from './types';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Session state TTL: 24 hours. Stale sessions auto-removed on cleanup. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

/** R(t) cache TTL: 30 seconds (same as OpenClaw) */
const RT_CACHE_TTL_MS = 30_000;

// ─── Persisted state schema ───────────────────────────────────────────────────

export interface PersistedSessionState {
  sessionId: string;
  agentId: string;
  startedAt: string;        // ISO 8601

  // ── R(t) cache ─────────────────────────────────────────────────────────────
  currentRt: number;
  currentMode: SafetyMode;
  grade: TrustGrade | null;
  /** ISO 8601 — R(t) cache expiry (30s TTL) */
  rtCacheExpiry: string;

  // ── Kill Switch ─────────────────────────────────────────────────────────────
  isHalted: boolean;
  haltReason?: string;

  // ── Session counters ────────────────────────────────────────────────────────
  dangerEvents: number;
  credentialBlocks: number;
  safetyGateBlocks: number;
  totalTurns: number;
  /** PermissionRequest 발생 횟수 — META_CONTROL 빈도 측정 (P3) */
  permissionRequestCount: number;
  /** SubagentStart 발생 횟수 — DRIFT/STABILITY 측정 (P2) */
  subagentSpawnCount: number;

  // ── Metadata ────────────────────────────────────────────────────────────────
  /** ISO 8601 — last update time (used for stale cleanup) */
  updatedAt: string;
  /** Monitor framework identifier — used to filter sessions in shared ~/.pmatrix/sessions/ */
  framework: string;

  // ── SessionStart double-fire defense ──────────────────────────────────────
  /** SessionStart 이중발화 방어 플래그 (CC v2.1.76 bugfix 대응) */
  sessionStartFired: boolean;

  // ── Observation counters (CC-3) ───────────────────────────────────────────
  /** Elicitation 요청 횟수 */
  elicitationCount: number;
  /** Context compact 발생 횟수 */
  compactCount: number;

  // ── CC v2.1.85 counters ──────────────────────────────────────────────────
  /** TaskCreated 발생 횟수 */
  taskCount: number;
  /** StopFailure 발생 횟수 */
  stopFailureCount: number;

  // ── CC v2.1.83/89/119 counters (v0.7.0) ──────────────────────────────────
  /** CwdChanged 발생 횟수 — reactive env 관찰 (direnv 등) */
  cwdChangeCount: number;
  /** FileChanged 발생 횟수 — fs change observer */
  fileChangeCount: number;
  /** PermissionDenied 발생 횟수 — auto mode classifier 거부 카운트 */
  permissionDeniedCount: number;
  /**
   * Recent tool durations in ms (last 100, ring buffer).
   * Captured from PostToolUse / PostToolUseFailure duration_ms (CC v2.1.119).
   * Forwarded to server for R(t) latency axis aggregation.
   */
  toolDurations: number[];
  /** Last observed cwd — set by CwdChanged */
  lastCwd?: string;
}

/** Ring-buffer cap for state.toolDurations */
export const TOOL_DURATIONS_MAX = 100;

// ─── Default state factory ────────────────────────────────────────────────────

function createDefaultState(sessionId: string, agentId: string): PersistedSessionState {
  const now = new Date().toISOString();
  return {
    sessionId,
    agentId,
    startedAt: now,
    currentRt: 0,
    currentMode: 'normal',
    grade: null,
    rtCacheExpiry: new Date(Date.now() - 1).toISOString(),  // expired immediately
    isHalted: false,
    dangerEvents: 0,
    credentialBlocks: 0,
    safetyGateBlocks: 0,
    totalTurns: 0,
    permissionRequestCount: 0,
    subagentSpawnCount: 0,
    updatedAt: now,
    framework: 'codex',
    sessionStartFired: false,
    elicitationCount: 0,
    compactCount: 0,
    taskCount: 0,
    stopFailureCount: 0,
    cwdChangeCount: 0,
    fileChangeCount: 0,
    permissionDeniedCount: 0,
    toolDurations: [],
  };
}

// ─── R(t) cache helpers ───────────────────────────────────────────────────────

export function isRtCacheValid(state: PersistedSessionState): boolean {
  return Date.now() < new Date(state.rtCacheExpiry).getTime();
}

export function buildRtCacheExpiry(): string {
  return new Date(Date.now() + RT_CACHE_TTL_MS).toISOString();
}

// ─── Directory helper ─────────────────────────────────────────────────────────

function sessionsDir(): string {
  return path.join(os.homedir(), '.pmatrix', 'sessions');
}

function sessionFilePath(sessionId: string): string {
  // Sanitize session_id for safe filename
  const safe = sessionId.replace(/[^a-zA-Z0-9\-_]/g, '_').slice(0, 128);
  return path.join(sessionsDir(), `${safe}.json`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Load session state from disk.
 * Returns null if the session file does not exist (new session).
 * Returns default state on parse error (fail-open).
 */
export function loadState(sessionId: string): PersistedSessionState | null {
  const filepath = sessionFilePath(sessionId);
  try {
    if (!fs.existsSync(filepath)) return null;
    const raw = fs.readFileSync(filepath, 'utf-8');
    // JSON.parse is safe here — wrapped by the enclosing try/catch (fail-open)
    const state = JSON.parse(raw) as PersistedSessionState;
    return state;
  } catch (err) {
    // Parse error or I/O error → treat as new session (fail-open)
    process.stderr.write(
      `[P-MATRIX] state-store: corrupted or unreadable state file for session=${sessionId} — ${(err as Error).message}\n`
    );
    return null;
  }
}

/**
 * Load or create session state.
 * Always returns a valid state object — fail-open for all errors.
 * Migration guard: backfills fields added after P1 (pre-existing state files may lack them).
 */
export function loadOrCreateState(sessionId: string, agentId: string): PersistedSessionState {
  const state = loadState(sessionId) ?? createDefaultState(sessionId, agentId);
  // permissionRequestCount added in P3 — guard against pre-P3 state files
  state.permissionRequestCount ??= 0;
  // subagentSpawnCount added in v0.2.0 — guard against pre-v0.2.0 state files
  state.subagentSpawnCount ??= 0;
  // framework added for session collision prevention — pre-existing files lack this field
  state.framework ??= 'codex';
  // CC-1: sessionStartFired added for double-fire defense
  state.sessionStartFired ??= false;
  // CC-3: observation counters
  state.elicitationCount ??= 0;
  state.compactCount ??= 0;
  // CC v2.1.85: new counters
  state.taskCount ??= 0;
  state.stopFailureCount ??= 0;
  // v0.7.0: CC v2.1.83/89/119 counters
  state.cwdChangeCount ??= 0;
  state.fileChangeCount ??= 0;
  state.permissionDeniedCount ??= 0;
  state.toolDurations ??= [];
  return state;
}

/**
 * Push a tool duration onto state.toolDurations, trimming to TOOL_DURATIONS_MAX.
 * Mutates the passed state object — caller must saveState() to persist.
 */
export function pushToolDuration(state: PersistedSessionState, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  state.toolDurations ??= [];
  state.toolDurations.push(durationMs);
  if (state.toolDurations.length > TOOL_DURATIONS_MAX) {
    state.toolDurations.splice(0, state.toolDurations.length - TOOL_DURATIONS_MAX);
  }
}

/**
 * Save session state to disk.
 * Atomic: write to temp file first, then rename.
 * Windows: rename not atomic. On corruption, state is non-authoritative —
 * hook execution continues fail-open, score falls back to R(t)=0.0 (safe default).
 * Fail-open: any error is silently swallowed.
 */
export function saveState(state: PersistedSessionState): void {
  try {
    const dir = sessionsDir();
    fs.mkdirSync(dir, { recursive: true });

    const filepath = sessionFilePath(state.sessionId);
    const tmpPath = `${filepath}.tmp`;

    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filepath);
  } catch {
    // Fail-open: state save failure must not block hook response
  }
}

/**
 * Delete session state file (called on SessionEnd).
 * Fail-open: errors silently ignored.
 */
export function deleteState(sessionId: string): void {
  try {
    const filepath = sessionFilePath(sessionId);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
  } catch {
    // ignore
  }
}

// ─── HALT file utilities ───────────────────────────────────────────────────────

/** Path to the global HALT file — presence means Kill Switch is active */
export function haltFilePath(): string {
  return path.join(os.homedir(), '.pmatrix', 'HALT');
}

/**
 * Check if HALT file is present (global Kill Switch check).
 * Called at the top of PreToolUse / PermissionRequest — before state load.
 * Fail-safe: returns false on any I/O error (fail-open pattern: block only when certain).
 */
export function isHaltActive(): boolean {
  try {
    return fs.existsSync(haltFilePath());
  } catch {
    return false;
  }
}

/**
 * Create HALT file to activate global Kill Switch.
 * Fail-open: errors silently ignored (halt best-effort).
 */
export function activateHalt(reason?: string): void {
  try {
    const dir = path.join(os.homedir(), '.pmatrix');
    fs.mkdirSync(dir, { recursive: true });
    const content = JSON.stringify({ activatedAt: new Date().toISOString(), reason: reason ?? '' });
    fs.writeFileSync(haltFilePath(), content, 'utf-8');
  } catch {
    // fail-open: HALT activation is best-effort
  }
}

/**
 * Read the most recently updated active session from ~/.pmatrix/sessions/.
 * Used by MCP tools when no session_id is provided.
 * @param framework — filter by framework (e.g. 'codex'). If omitted, returns any framework.
 * Returns null if no sessions found.
 */
export function findActiveSession(framework?: string): PersistedSessionState | null {
  try {
    const dir = sessionsDir();
    if (!fs.existsSync(dir)) return null;

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    if (files.length === 0) return null;

    let latest: PersistedSessionState | null = null;
    let latestTime = 0;

    for (const filename of files) {
      try {
        const filepath = path.join(dir, filename);
        const raw = fs.readFileSync(filepath, 'utf-8');
        const state = JSON.parse(raw) as PersistedSessionState;
        // Filter by framework if specified — prevents cross-monitor session collision
        if (framework && state.framework && state.framework !== framework) continue;
        const t = new Date(state.updatedAt).getTime();
        if (t > latestTime) {
          latestTime = t;
          latest = state;
        }
      } catch {
        // skip unreadable files
      }
    }

    return latest;
  } catch {
    return null;
  }
}

/**
 * Remove stale session files older than SESSION_TTL_MS.
 * Called opportunistically on SessionStart — never blocks.
 */
export function cleanupStaleStates(): void {
  try {
    const dir = sessionsDir();
    if (!fs.existsSync(dir)) return;

    const now = Date.now();
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') || f.endsWith('.json.tmp'));

    for (const filename of files) {
      try {
        const filepath = path.join(dir, filename);
        const stat = fs.statSync(filepath);
        // .json.tmp files: orphaned from crashed saveState — always remove
        // .json files: remove if older than SESSION_TTL_MS
        if (filename.endsWith('.tmp') || now - stat.mtimeMs > SESSION_TTL_MS) {
          fs.unlinkSync(filepath);
        }
      } catch {
        // ignore individual file errors
      }
    }
  } catch {
    // ignore all cleanup errors
  }
}
