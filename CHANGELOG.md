# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-06-12

win32-safe spawn 根治 + gemini-batch resume/stream/approval 能力补全 + 一组安全收敛。
本版把 `gemini-batch.mjs`（1.1.0 引入的非 ACP 快路径入口）从「能跑」推进到「功能对齐
companion + 在未信任目录/Windows 下安全可靠」，并修掉两个会让整条 Windows 路径静默失效的
根因（`prompts.mjs` 路径、`process.mjs` spawn）。

### Added

- **`gemini-batch.mjs` session resume (`F4`)**：新增 `--resume <id|index>`（→ `gemini -r <id>`）
  与 `--resume-last`（→ `gemini -r latest`）。显式 id 优先于 `--resume-last`——并行双模型
  跑会在 `latest` 上撞车，调用方手里有 `threadId` 时应永远赢。`--resume-last` 从旧的
  companion-compat no-op 提升为真实转发。
- **`gemini-batch.mjs` streaming 输出 (`F5`)**：`--stream-output` 把 CLI 切到
  `-o stream-json`（JSONL 事件流）。新增 `createStreamParser`：增量解析每行 JSONL，从
  `message`（`delta:true` 追加 / 否则整条替换）重建 assistant 文本，从 terminal `result`
  事件提 `stats`（token usage），`init` 事件取 `session_id`/`model`。每行刷新 idle 时钟——
  长任务的 idle 检测自此才有意义（plain `json` 模式全程静默，任何正 idle 都误杀）。默认仍
  plain `json`（BC）。
- **`gemini-batch.mjs` approval mode (`F6`)**：新增 `--yolo` / `--approval-mode <default|auto_edit|yolo|plan>`，
  并新增 `resolveApprovalMode()`：显式 `--approval-mode` 最高优先；`--write --yolo` → `yolo`；
  `--write` → `auto_edit`；无 `--write`（只读任务）→ `default`（headless 下自动拒一切需审批的
  tool call，写操作被拒）。**不映射 `plan`**：gemini-cli 0.42 非交互模式下 `exit_plan_mode`
  的 `getAllowApprovalMode()` 直接返回 YOLO——模型自己调一次 exit_plan_mode 就把会话升级成
  全自动批准，`plan` 在 batch 模式下不是只读保证（已在 CLI bundle 源码核实）。
  **总是显式传 `--approval-mode`**，权限级别由本层钉死而非依赖 CLI build 的默认值。
- **`gemini-batch.mjs` `--prompt-file <path>`**：从文件读 prompt 正文，优先级高于 `-p/--prompt`，
  文件不可读则按既有 error envelope 格式报错退出。动机：Windows spawn 在 argv 总长超
  ~32K 时同步抛 `ENAMETOOLONG`——大段 review prompt 不能走 argv，必须走文件。
- **`gemini-batch.mjs` `--mcp-allow <names>` (`C8`)**：选择性 MCP allowlist（真实 server 名
  逗号/空格列表），优先于 `--allow-mcp`；ccgx 集成 helper 借此转发检索类 server
  （fast-context / context7），其余 server 维持默认全压制、batch 启动保持快。
- **`gemini-batch.mjs` `--include-directories <dirs>` (`C9`)**：额外只读 workspace 目录，
  逐字转发 gemini-cli `--include-directories`，用于跨仓 / worktree review。
- **`gemini-batch.mjs` 可测试面 + 行为测试**：`buildCliArgs` 抽成纯函数，入口加
  isMainModule 守卫（import 不再触发 main），末尾导出
  `__testing = { parseArgs, resolveApprovalMode, resolvePrompt, buildCliArgs, createStreamParser, ... }`。
  新增 `tests/gemini-batch.test.mjs`（19 用例）：approval-mode 优先级矩阵、C8 三分支、
  C9 条件转发、`--skip-trust`/`-e none` 恒在、`--prompt-file` 解析与优先级、stream buf cap、
  win32 spawn 注入回归（`.cmd` shim：`&`/`%`/空格逐字到达、链式命令不执行、stdin 透传、
  embedded-quote fail-closed）。
- **`lib/process.mjs` `spawnSafe()` 导出**：异步 spawn 版的 buildSafeSpawn 封装（PATHEXT
  解析 + `.cmd` 经 cmd.exe 包裹 + 全 args 过 `cmdEscapeArg`），非 win32 平台为普通 spawn。
  三处 `shell:true` spawn 全部改走它：`gemini-batch.mjs` 主 spawn、
  `acp-client.mjs` SpawnedAcpClient、`acp-broker.mjs` spawnAcpProcess（env 派生的
  allowlist 参数同样过转义）。代码库自此零 `shell:true`。
- **`gemini-batch.mjs` `--skip-trust` + `-e none` (`F7`)**：spawn gemini-cli 时传
  `--skip-trust`（信任当前 cwd，治 env-bridge 根因：gemini-cli 在未信任目录跳过项目级
  config）+ `-e none`（禁所有 extension，保 fresh-context subagent prompt 纯净可复现）。
  env bridge 保留作 fallback（部分 CLI build 独立于 trust 门 gate env 加载）。
- **`gemini-batch.mjs` stdout 背压 cap (`F8`)**：32MiB 上限，镜像 ACP 路径的 1MiB
  backpressure 守卫。超限后停止累积（保留已有部分做 best-effort parse），但继续喂 stream
  parser（只持单行 partial）。错误信息标注 `stdout truncated at <N> bytes`。
- **`createStreamParser` 行缓冲上限（8MiB）**：补齐 F8 防线——parser 自持的未完成行缓冲
  原本无上限，无换行洪流可绕过 32MiB stdout cap 直至 OOM。超限丢弃当前 partial 行并计入
  `parseErrors`，后续完整行照常解析。
- **auth base-url 桥接 (`GEMINI_AUTH_ENV_KEYS` 扩展)**：补 `GOOGLE_GEMINI_BASE_URL` /
  `GOOGLE_VERTEX_BASE_URL` / `GOOGLE_GENAI_USE_VERTEXAI` 三个 endpoint 路由 key。只桥接
  `GEMINI_API_KEY` 不桥接 base-url，会把指向自建网关的 key 发到 Google 官方 endpoint。
  `tests/gemini-env.test.mjs` 同步断言新 allowlist。
- **`lib/process.mjs` Windows 安全 spawn**：新增 `resolveWindowsCommand`（PATH×PATHEXT
  解析绝对路径，镜像 Go `exec.LookPath`）+ `buildSafeSpawn`（`.cmd`/`.bat` 经
  `cmd.exe /d /s /c "<path>" <args>` + `windowsVerbatimArguments`，CVE-2024-27980 缓解）。
  `runCommand` / `binaryAvailable` 接入。

### Changed

- **`gemini-rescue` agent 默认路由 batch**：默认 forward `gemini-batch.mjs`（一次性 rescue
  无需 ACP 多轮/streaming/`fs/*`，Windows 上 ACP 路径稳定卡分钟级）；仅 resume 续跑
  （`--resume` 且无 `--fresh`）fallback 到 `gemini-companion.mjs --resume-last`。`--write`
  语义文档同步为 `auto_edit`（非任意 shell），read-only 为 `default`（headless 自动拒写）。
- **`extractJsonPayload` 改 brace-depth 扫描**：从首个 `{` 起追踪括号深度（忽略字符串字面量
  内的括号）返回第一个平衡对象。旧 `JSON.parse(stdout.slice(indexOf('{')))` 遇 payload 前后
  任意裸 warning 行就抛——gemini-cli 会在 JSON 前/后写 warning 到 stdout。
- **marketplace.json / plugin.json → 1.3.0**：version-sync（plugin.json 已先行至 1.2.0，
  本版与 marketplace 一并提到 1.3.0）。

### Fixed

- **`prompts.mjs` Windows 路径（fileURLToPath）**：`new URL("../../prompts", import.meta.url).pathname`
  在 Windows 产出 `/C:/Users/...`，`path.resolve` 再拼上 cwd 盘符 → `D:\C:\...` 非法路径
  → `loadPrompt()` 对**每个** prompt 模板 ENOENT。改用 `fileURLToPath(new URL(...))`。这是个
  让整条 Windows prompt-加载路径静默全挂的根因。
- **`process.mjs` spawn 不再依赖 `shell:true`**：bare `gemini`（Windows 上是 `.cmd` шим）
  经 spawnSync ENOENT → `getGeminiAvailability()` 报「不可用」→ Stop review gate 在每台
  Windows 装机上静默 fail-open（review 从不跑）。改走绝对路径解析 + `shell:false`——
  顺带消除把整段模型响应塞进 `-p` 时 `shell:true` 的 cmd 命令注入面。
- **`acp-client.mjs` 反向请求不再挂死 (acp-handler)**：server→client 反向 REQUEST
  （同时带 `id` + `method`，如 `fs/*` / `session/request_permission`）在无 handler 时会让
  agent 等到 30min streaming timeout。现立即回 JSON-RPC `-32601`（Method not supported）
  让 agent 快速失败。**仅直连 transport 闭环**（sendMessage 直写 gemini child stdin）；
  broker 模式无 client→child 响应路径，broker-mode hang 不被此单独闭合（见 PLUGIN-PATCHES.md）。

### Security

- **read-only 任务默认拒写（`default`，非 `plan`）**：`resolveApprovalMode` 默认（无 `--write`）
  → gemini-cli `default` 模式——headless 下需审批的写工具一律被自动拒绝。`plan` 看似更硬，
  实测在非交互模式存在逃逸：`exit_plan_mode` 被策略自动批准后会话切 YOLO（CLI 源码
  `getAllowApprovalMode()` 对 `!isInteractive()` 返回 YOLO）。`default` 才是 batch 模式下
  最接近硬保证的只读映射——这正是审计 flag 的「安全坍缩」修复点。注意 `--skip-trust`
  仍然保留（非交互防挂起所需），它会削弱 spawned 会话的 folder-trust 信任边界。
- **Windows spawn 去 shell 注入面（全量根治）**：`spawnSafe` 接管全部三处异步 spawn
  （gemini-batch 主 spawn / SpawnedAcpClient / broker spawnAcpProcess），加上既有的
  `runCommand`，代码库零 `shell:true`。argv 内容（prompt、model、include dirs、env 派生
  allowlist）永不交给 shell 解析器：`.cmd` shim 经 cmd.exe 包裹时每个参数过 `cmdEscapeArg`，
  `& | < > ( ) ^ %` 全部失效。stop-review-gate 把整段 session 响应经 `-p` 入 argv，
  `shell:true` 会把任意 session 内容变成 cmd.exe 命令注入面。注入回归用例钉死该面
  （`tests/gemini-batch.test.mjs` + `tests/process.test.mjs`）。
- **auth key 不发错 endpoint**：base-url 路由 key 与 auth key 一并桥接，杜绝自建网关 key
  被发往 Google 官方 endpoint。

### Stats

- 16 files changed since 1.2.0（`git diff --stat HEAD` 实测：15 files, +928 / -116，另新增
  `tests/gemini-batch.test.mjs` 225 行）——gemini-batch 大改（prompt-file / approval-mode /
  buildCliArgs / __testing）+ process.mjs win32-safe spawn（`spawnSafe` 导出，三处
  `shell:true` 根治）+ acp-client/acp-broker spawn 收编 + env allowlist + rescue agent 路由
  + README/CHANGELOG 文档同步。
- Test suite: `node --test tests/*.test.mjs` 221 / 221 passing on Windows（含
  `tests/gemini-batch.test.mjs` 19 新用例：approval 矩阵 / C8 / C9 / prompt-file /
  stream buf cap / win32 注入回归）。

## [1.2.0] - 2026-06-04

### Added

- **`~/.gemini/.env` 认证桥接**（新模块 `scripts/lib/gemini-env.mjs`）。gemini-cli 0.42 仅在 folder-trust **信任**的 cwd 下加载 `~/.gemini/.env`（`security.folderTrust` 默认开启），未信任目录里 `findEnvFile()` 跳过该路径 → 用户的 `GEMINI_API_KEY` 明明在文件里却被报"未配置"。`applyHomeGeminiAuthEnv()` 在进程入口把 `~/.gemini/.env` 的 4-key auth allowlist（`GEMINI_API_KEY` / `GOOGLE_API_KEY` / `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION`）**仅在缺失时**提升进 `process.env`，让 gemini-cli 走"环境变量优先"路径绕过 trust 门。一个机制同时修复检测层误报与执行层未认证。
- 4 个会带认证调用 gemini 的进程入口接入桥接：`gemini-companion.mjs`、`gemini-batch.mjs`、`acp-broker.mjs`、`stop-review-gate-hook.mjs`。
- **opt-out**：`GEMINI_COMPANION_NO_ENV_BRIDGE` 设为真值（如 `1`/`true`）禁用桥接；`0`/`false`/空被忽略。
- `tests/gemini-env.test.mjs`（19 测试，含入口 wiring 防回归）。

### Fixed

- **stop-review-gate-hook fail-closed**：未信任目录下，hook 进程内的 gemini review 因"未配置"返回非 0 → 直接 block 会话停止。桥接覆盖该路径后消除。

### Why

根因是 gemini-cli 把 `~/.gemini/.env` 的加载放在 folder-trust 门后，而 plugin 用 `env: process.env` spawn 时从不透传该文件、子进程在未信任 cwd 自己也读不到它。auth 类 key 本就不是 folder-trust 的保护面——gemini-cli 自身在未信任目录也会从 `~/.env`/项目 `.env` 加载同一份 allowlist——因此提升 home 级 auth key 不引入新的信任越权；项目级 `.env` 仍受 trust 门保护。

## [1.1.2] - 2026-05-12

### Fixed (v1.1.1 regression)

- **`gemini-batch.mjs` idle 默认 600000 → 0**（disabled）。v1.1.1 引入的 10min idle 检测在 gemini-cli `--output-format json` 模式下误杀健康长任务——batch 模式只在启动吐 4-5 行 warning，然后进入静默 reasoning + tool call 直到最后才一次性输出 JSON。任何正值 idle 都会在长任务中击中。改为 OPT-IN，wall-time 2h 兜底保留。
- 调用方仍可显式传 `--idle-timeout-ms <N>` 启用。

## [1.1.1] - 2026-05-12

### Added

- **`gemini-batch.mjs` 自洽 idle + wall-time 超时**。两层 timer 替代之前的"永等"行为：
  - `--idle-timeout-ms <N>`（默认 600000ms = 10min）：监控 stdout/stderr 任何 chunk，N ms 内零输出 → 判定 hung → 杀整棵进程树。这是健康长任务（持续产 progress）vs 真死锁（沉默）的分界。
  - `--timeout-ms <N>`（默认 7200000ms = 2h）：总 wall-time 兜底安全网。
  - 任一传 `0` 禁用对应检测。
- **Windows 进程树 kill** (`killProcessTree`)。`shell:true` spawn 产生 `cmd.exe → gemini.cmd → node gemini.js` 三层链，SIGTERM 单杀只死最顶层 cmd.exe，下游孤立残留。新增 `taskkill /T /F /PID <pid>` 走整棵子树，POSIX 仍走 SIGTERM（fall-through）。

### Why

调用者（如 ccg-workflow 的 `ccgx-call-plugin.mjs`）外层 SIGTERM 只能砸到 gemini-batch 直接子，导致 gemini-cli + cmd.exe shim 残留为孤儿。让 gemini-batch 自己在 idle/wall 触发时 `taskkill /T` 是把进程树管理收到这一层最干净。

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
