# Changelog

All notable changes to `@pmatrix/codex-monitor` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### M3 (Phase R-7) — Full hook coverage
- Full Safety Gate logic in `pre-tool-use.ts` (R(t) classification + meta-control rules + signal flow)
- Full approval tracking in `permission-request.ts` (cross-process approval ID correlation)
- Full session_report in `stop.ts` (sendSessionSummary)
- AP-2 file_write event emission in `post-tool-use.ts` (apply_patch path extraction)
- Test suite (jest, mirroring claude-code-monitor v0.7.0 coverage)

### M5 (Phase R-7+, optional)
- MCP server (`pmatrix-codex mcp`) — `pmatrix-status` / `pmatrix-grade` / `pmatrix-halt` (3 tools)
- `requirements.toml` enterprise mode (`pmatrix-codex setup --enterprise`)

---

## [0.1.1] — 2026-05-21

### Changed

- **Migrate to `@pmatrix/core-sdk@^0.1.0`** — `PMatrixHttpClient` 와 공통 schema (5-layer Agent Host-Integration Adapter Contract v0.1)를 `@pmatrix/core-sdk` 로 위임. SDK 자체 substance 큰 폭 감소, API surface 변경 0 (consumer 영향 없음).

### Verification

- Fresh install: `node_modules/@pmatrix/core-sdk` 가 registry tarball 추출 confirmed (symlink=false / version=0.1.0)
- Tests: 174 PASS, regression 0 (R-X.4 lockstep verify, monorepo commit `d1a6d08`)

### Lockstep §6.3 v0.2

- `@pmatrix/core-sdk` 의존성을 caret range `^0.1.0` 으로 declared. Core SDK major bump 시 6 adapter SDK 동시 major bump 의무.

---

## [0.1.0] — 2026-05-04 (M2 PoC)

### Added
- **Initial release** — P-MATRIX 5번째 SDK, OpenAI Codex CLI v0.124.0+ (hooks GA, 2026-04-23) 대상.
- **6 hook lifecycle support**: SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest / PostToolUse / Stop.
- **Safety Gate skeleton** (M2 stub — full implementation in M3): HALT file check + structure for R(t) × Tool Risk classification.
- **Kill Switch shared with 4 SDK family** — `~/.pmatrix/HALT` file activates kill switch across all 5 P-MATRIX monitors.
- **Credential Protection** — 16 patterns from `claude-code-monitor` (full functional).
- **BreachSupport file persistence** — `~/.pmatrix/sessions/{id}_breach.json` (claude-code-monitor pattern).
- **Cross-cutting A/B/C from c318e70** (server `533781f` counterpart):
  - A: `error_id` correlation (5xx response body extraction)
  - B: `X-Request-ID` header propagation
  - C: Burst 429 escalating retry (`[1s, 5s, 30s]`) + `Retry-After` priority
- **localUrl fallback** — `PMATRIX_LOCAL_URL` env var (try local sidecar → server).
- **Setup CLI** — `pmatrix-codex setup` writes `~/.codex/hooks.json` (or `<cwd>/.codex/hooks.json` with `--repo`).
- **Server framework enum**: `framework: "codex"` + `signal_source: "codex_hook"` (Lockstep Protocol §6.5 first fully-lockstep application).

### Codex-specific
- `apply_patch` tool detection in PostToolUse (matchers: `apply_patch`, `Edit`, `Write`).
- `tool_name` identification: `Bash` / `apply_patch` / `mcp__<server>__<tool>`.

### Limitations (v0.1.0)
- M2 stub level — Safety Gate / approval tracking / session_report / AP-2 file_write event emission deferred to M3.
- AP-2 file_read not supported (Codex CLI itself does not provide file_read hook).
- LLM call observation not supported (Codex CLI itself does not provide BeforeModel/AfterModel hooks; Gemini CLI Monitor is unique).
- Subagent / PostCompact / Worktree / Elicitation hooks absent (Codex CLI 6 hook subset).
- WebSearch interception not supported (Codex CLI itself does not emit).

### Reference
- Spec: [PMATRIX_CODEX_MONITOR_v1_0_PRODUCT_SPEC.md](../docs/PMATRIX_CODEX_MONITOR_v1_0_PRODUCT_SPEC.md)
- Sister SDK: `@pmatrix/claude-code-monitor` v0.7.0 (~70% code reuse)
- Codex CLI hooks reference: https://developers.openai.com/codex/hooks
