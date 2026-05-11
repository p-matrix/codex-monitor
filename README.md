# @pmatrix/codex-monitor

Runtime safety governance for **OpenAI Codex CLI** — **active intervention, not just logging.**

Blocks dangerous tool calls before execution, detects credential leaks in user prompts, and continuously measures agent risk with live Trust Grade (A–E).

> Requires a P-MATRIX account, API key, and Codex CLI v0.124.0+ (hooks GA, 2026-04-23).

---

## What it does

### Core Protection

- **Safety Gate** — Intercepts high-risk tool calls (`Bash`, `apply_patch`, `mcp__*`) before execution. Blocks based on current risk level R(t).
- **Credential Protection** — Detects and blocks 16 types of API keys and secrets in user prompts before they reach the agent.
- **Kill Switch** — Automatically halts the agent when R(t) ≥ 0.75. Manually via `~/.pmatrix/HALT` (shared across 5 P-MATRIX SDKs — Claude Code / Cursor / Gemini / OpenClaw / Codex).

### Codex-specific Features

- **apply_patch AP-2** — Direct observation of file edits via `apply_patch` (or `Edit`/`Write` matchers). Path extraction + scope tagging.
- **tool_name identification** — `Bash` (shell), `apply_patch` (file edit), `mcp__<server>__<tool>` (MCP tools).
- **requirements.toml support** (v0.2+) — Codex CLI's enterprise hook system for organization-wide governance enforcement.

### Behavioral Intelligence

- **Tool Failure Tracking** — Records each tool failure and applies a stability nudge.
- **Live Grade** — Streams 4-axis safety signals and displays Trust Grade (A–E) in real time.

### Hooks (6)

| Hook | Role | Block? |
|:---|:---|:---|
| SessionStart | Session bootstrap | — |
| UserPromptSubmit | Credential scan (16 patterns) | exit 2 |
| PreToolUse | Safety Gate core | JSON deny |
| PermissionRequest | Approval workflow | JSON deny |
| PostToolUse | R(t) update + apply_patch AP-2 | — |
| Stop | session_report + breach flush | — |

---

## Requirements

| Requirement | Version |
|:---|:---|
| Node.js | >= 18 |
| Codex CLI | v0.124.0+ (hooks GA) |
| P-MATRIX server | v1.0.0+ |
| Platform | macOS / Linux / Windows |

---

## Install

```bash
npm install -g @pmatrix/codex-monitor
pmatrix-codex setup --agent-id <YOUR_AGENT_ID>
export PMATRIX_API_KEY=<YOUR_API_KEY>
```

`setup` writes hook configuration to `~/.codex/hooks.json`. Use `--repo` flag to write to `<cwd>/.codex/hooks.json` instead (per-repository setup).

Restart Codex CLI to activate monitoring.

---

## Configuration

| Env var | Default | Description |
|:---|:---|:---|
| `PMATRIX_API_KEY` | (required) | Your P-MATRIX API key |
| `PMATRIX_AGENT_ID` | (required) | Your agent identifier |
| `PMATRIX_SERVER_URL` | `https://api.pmatrix.io` | Server URL |
| `PMATRIX_LOCAL_URL` | (optional) | Local sidecar URL — try sidecar first, fall back to server |
| `PMATRIX_DEBUG` | `0` | Set to `1` to log debug info to stderr |
| `PMATRIX_DEBUG_TRACE` | `0` | Set to `1` to log X-Request-ID echo to stderr |

---

## P-MATRIX 5 SDK Family

| SDK | Hook count | Distinguishing feature |
|:---|:---:|:---|
| `@pmatrix/openclaw-monitor` | 28+ events | In-process plugin, richest hook surface |
| `@pmatrix/claude-code-monitor` | 19 hooks | Command Hook + MCP, file-persisted state |
| `@pmatrix/cursor-monitor` | 14 hooks | Shell command direct analysis + AP-2 bidirectional |
| `@pmatrix/gemini-cli-monitor` | 10 hooks | LLM call observation (BeforeModel/AfterModel) |
| **`@pmatrix/codex-monitor`** | **6 hooks** | **apply_patch direct observation + requirements.toml** |

All 5 SDKs share `~/.pmatrix/HALT` Kill Switch — single file activates kill switch across all monitors.

---

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting policy.

---

`P-MATRIX Codex Monitor v0.1.0 (initial) · Phase R-7 · 2026-05-04`
