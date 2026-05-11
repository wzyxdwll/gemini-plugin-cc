# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-05-12

### Added

- **`gemini-batch.mjs` — non-interactive entry that bypasses ACP broker.** New plugin entry script peer to `gemini-companion.mjs task`. Drives the upstream `gemini` CLI in batch mode via stdin + `--output-format json`, skipping the ACP broker + named-pipe transport entirely. Verified: trivial task drops from a silent 5+ min ACP hang to a 29s clean exit with **zero orphan MCP children**.
  - **Why a separate entry, not a fix to ACP path.** Multiple rounds of dogfood + independent codex audit showed `session/new` hangs reliably on Windows + gemini-cli 0.40+ for reasons NOT eliminated by P-21 `waitForBrokerReady`, P-15/P-18 client timeouts, the `--allowed-mcp-server-names` MCP suppression, or P-2a/P-2b Windows shell patches. The hang originates inside gemini-cli's `newSession()` (auth refresh + chat startup) where the ACP transport silently fails to surface progress or errors. Batch mode sidesteps the entire transport stack.
  - **CLI surface.** Drop-in for `gemini-companion.mjs task` flags so existing callers (e.g. ccg-workflow's `ccgx-call-plugin.mjs`) route to the new entry without changing invocation: `task -p <prompt> [--json|--no-json] [--write] [--model <name>] [--cwd <path>] [--allow-mcp]`. Default suppresses settings.json MCP servers via the same `--allowed-mcp-server-names` sentinel to keep startup fast and the process tree clean.
  - **Output envelope.** Identical JSON shape to `gemini-companion task` (`status` / `threadId` / `rawOutput` / `touchedFiles` / `reasoningSummary` / `durationMs` / `stats`) so wrappers don't need branching.
- **`--allowed-mcp-server-names` threading via `lib/acp-args.mjs`.** Both ACP spawn sites (`acp-broker.spawnAcpProcess` and `acp-client.SpawnedAcpClient.initialize`) now build their argv through `buildGeminiAcpArgs(env)`. Default appends a sentinel allowlist name so `settings.json` MCP merges to empty for ACP sessions too; override via `GEMINI_COMPANION_ACP_ALLOWED_MCP_SERVERS=name1,name2`. Trims 30-60s of Windows first-spawn MCP cold-start tax from the ACP path (which is still kept for users needing streaming / multi-turn / fs-callback features that batch mode lacks).
- **CCG ACP-stability patches (P-14 / P-15 / P-17 / P-18).** Broker watchdog + per-method client timeouts + native ACP `session/cancel` passthrough. Hung broker / gemini --acp no longer blocks callers indefinitely (5-min default for non-streaming RPCs, 30-min for `session/prompt`, both env-tunable: `ACP_REQUEST_TIMEOUT_MS` / `ACP_STREAMING_TIMEOUT_MS`). Broker daemon self-exits after `BROKER_IDLE_TIMEOUT_MS` (default 30 min) of no client activity instead of surviving until reboot.
- **CCG P-19 / P-20 / P-21 (Critical fixes from codex independent review).** P-19 broker rejects malformed JSON-RPC; P-20 force-aborts socket on broker timeout so the broker promptly cancels the in-flight prompt; P-21 client waits for `broker/ready` RPC (not just socket-listening) before sending real requests — eliminating race where the broker accepted client traffic before the ACP child had completed its own initialize.
- **W1 + W2 interrupt + broker startup concurrency** (codex review continued). `interruptAcpPrompt` no longer silently spawns a fresh `gemini --acp` child when no broker session exists; broker startup serializes correctly when multiple companion calls race for the first slot.
- **CCG ccg-baseline patches P-1 / P-2a / P-2b / P-4 / P-5 / P-6 / P-7 / P-9 / P-12.** Inlined the patch set that ccg-workflow's `repatch-gemini-plugin.mjs` previously applied at install time. With these baked in, downstream users of this fork no longer need the repatch step. Highlights: `windowsHide` + `shell:win32` on every Windows spawn (without which `gemini.cmd` shim resolution fails outright); JSON-RPC error wrap in `acp-client.mjs:handleLine` so callers see real error messages instead of `[object Object]`; `CLAUDE_PLUGIN_DATA` recomputed from script path to prevent cross-plugin env contamination.

### Changed

- **Broker startup grace 5s → 30s default** (`BROKER_STARTUP_TIMEOUT_MS` env-tunable). The P-21 `waitForBrokerReady` timeout was too tight in practice because gemini-cli's `--acp` mode synchronously connects to every MCP server in `~/.gemini/settings.json` before responding to its first `initialize` RPC — 5 typical MCPs reliably push past 5s on first spawn.
- **Broker `broker.log` preserved on spawn-failure teardown** for post-mortem support. Previously deleted with the session dir, hiding the only signal explaining why an ACP startup didn't complete.

### Fixed

- **`spawnDetached` `logFile` option dead-code branch.** Both ternary branches were identical (#29 / #40); now correctly differentiates the detach vs inline path. (Inherited from upstream.)

### Stats

- 11 files changed since 1.0.1; ~1080 lines added across new entry, helpers, and patch inlining.
- Test suite: `npm test` passing on Windows.

## [1.0.1] - 2026-04-18

### Added
- **Streamed ACP output and thought chunks** ([#20], closes [#15]). `runAcpPrompt` now distinguishes `agent_thought_chunk` from `agent_message_chunk` end-to-end, accumulates a separate `thoughtText` return field, and records a dedicated `model_thought_chunk` event (char counts only — raw prose is never persisted).
- **`--stream-output` flag** for `/gemini:rescue` and `/gemini:review` ([#20]). Live stderr forwarding of model chunks and thoughts (with a `thought:` prefix). Default mode shows compact progress markers (`[session]`, `[tool]`, `.` per chunk, `[thinking]`, `[file]`, `[done] stats`). EPIPE-safe; auto-suppressed in `--json` mode unless explicitly opted in.
- **`--thinking <off|low|medium|high>` flag** ([#20]). T-shirt-sized reasoning budgets that resolve per model family (Gemini 3 / 3.1 `thinkingLevel`; Gemini 2.5 `thinkingBudget` with off→low clamping). Replaces the non-functional `--thinking-budget <n>`. Emits a one-shot stderr warning noting that upstream Gemini CLI 0.38.x delivers thinking via persistent `settings.json`, not per-invocation.
- **Gemini job observability** ([#16], closes [#14]). New `lib/job-observability.mjs` helper with bounded event log (50 events/job, 500-char diagnostic cap, ANSI/CSI/OSC/DCS stripping). Derived health fields expose liveness, progress, rate-limit, auth-block, broker, and worker states.
- **`/gemini:status` event tail** ([#16], [#20]). `renderSingleJobStatus` shows the last 5 sanitized events with human-readable `Ns ago` timestamps, rollup counters (`chunks/thoughts/tools/files`), and graceful fallback when the event log is absent.
- **Broker trust boundary** ([#16]). Distinct `broker/diagnostic` JSON-RPC method prevents compromised children from forging broker notifications.
- **CI test workflow** ([#9]). `.github/workflows/test.yml` runs `npm test` on every PR. PR cleanup workflow added.
- **Docs-agreement test suite** ([#20]). `tests/docs-agreement.test.mjs` asserts `--thinking` and `--stream-output` stay documented across `README.md`, `rescue.md`, and `review.md`, and that the stale `--thinking-budget <number>` form is gone.

### Changed
- **Model mapping and selection guidance** ([#8], closes [#7]). Updated default model aliases and selection guidance in `/gemini:rescue` and `/gemini:review` for clearer routing between Pro, Flash, and Flash-Lite.
- **ACP protocol type definitions** ([#20]). `lib/acp-protocol.d.ts` replaces the stale `AcpNotification` union (`progress`/`toolCall`/`fileChange`/`error` — none matched the real runtime) with `SessionUpdateNotification` modeling `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `file_change`, plus `broker/diagnostic`.
- **Documentation**. `README.md` adds a "Live Progress & Thinking Levels" section; `plugins/gemini/commands/rescue.md`, `plugins/gemini/commands/review.md`, and `plugins/gemini/agents/gemini-rescue.md` refreshed with new `argument-hint` and runtime-flag lists.

### Fixed
- **Root workspace path containment** ([#13], closes [#6]). Path containment check no longer false-negatives at filesystem root (`/`).
- **ACP broker socket permissions (TOCTOU)** ([#12], closes [#5]). Socket permissions now set atomically to eliminate the time-of-check-to-time-of-use race.
- **ACP protocol type map** ([#10], closes [#3]). Aligned the type definitions with the runtime method name that was actually being dispatched.
- **`--scope` flag validation** ([#9], closes [#2]). Invalid values now fail fast with a clear error instead of silently falling back to `working-tree`.
- **PID-reuse false positives** ([#16]). `defaultIsProcessAlive` now treats `EPERM` as a dead worker to avoid reading a stranger process as alive after a PID is recycled.

### Removed
- **Dead code in `stop-review-gate-hook`** ([#11], closes [#4]). Unused imports and branches pruned.
- **`--thinking-budget <number>` flag** ([#20]). Replaced by `--thinking <off|low|medium|high>`; the numeric form was non-functional.

### Security
- **Broker passthrough forgery (HIGH)** ([#16]). Broker no longer forwards arbitrary child notifications as broker-origin diagnostics.
- **Diagnostic sanitization** ([#16]). All broker and worker diagnostics strip ANSI/CSI/OSC/DCS sequences and enforce a 500-char cap before entering the event log or the compact job index.
- **Privacy-preserving observability** ([#16], [#20]). Compact job-index and progress events use an explicit allow-list. Raw prompts, raw model prose, and raw thought prose never enter job files, status output, or logs — only char counts.

### Stats
- 51 files changed, +4547 / -263 lines across 8 merged PRs.
- Test suite: 172 / 172 passing.

[1.0.1]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/compare/v1.0.0...v1.0.1
[#20]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/pull/20
[#16]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/pull/16
[#15]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/issues/15
[#14]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/issues/14
[#13]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/pull/13
[#12]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/pull/12
[#11]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/pull/11
[#10]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/pull/10
[#9]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/pull/9
[#8]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/pull/8
[#7]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/issues/7
[#6]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/issues/6
[#5]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/issues/5
[#4]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/issues/4
[#3]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/issues/3
[#2]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/issues/2
