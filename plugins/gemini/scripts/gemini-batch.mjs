#!/usr/bin/env node

/**
 * gemini-batch.mjs — non-interactive batch entry point for the gemini-plugin-cc
 * fork. Drop-in alternative to `gemini-companion.mjs task` that bypasses the
 * ACP broker layer entirely and drives the upstream `gemini` CLI in batch mode
 * via stdin + `--output-format json` (or `stream-json` when --stream-output).
 *
 * Why this exists:
 *   gemini-cli 0.40+ runs MCP startup + auth refresh + chat startup
 *   synchronously inside `session/new`. On Windows the ACP broker / wrapper
 *   chain (broker daemon + named-pipe transport + JSON-RPC `session/new`)
 *   reliably hangs the trivial trip even when the underlying CLI works
 *   directly. Verified in fork v1.0.1 dogfood:
 *     - direct `gemini ... --allowed-mcp-server-names __nope__` → 11s, exit 0
 *     - ACP broker path → 5+ min silent hang, helper SIGTERM-only termination
 *
 *   For ccg-workflow's one-shot rescue / review / analyze tasks the ACP
 *   features (multi-turn sessions, streaming, fs/* client-method callbacks)
 *   are unused, so we skip the entire ACP transport and call the CLI in batch
 *   mode. Side benefit: gemini-cli exits cleanly when the prompt completes,
 *   so MCP children and the wrapper child all die together — no orphan
 *   accumulation on Windows where `child.kill()` doesn't traverse the tree.
 *
 * CLI surface (matches the subset of `gemini-companion.mjs task` flags that
 * ccgx-call-plugin.mjs passes through, so callers don't change):
 *
 *   gemini-batch.mjs task -p <prompt> [--prompt-file <path>]
 *                         [--json|--no-json] [--write]
 *                         [--model <name>] [--cwd <path>] [--allow-mcp]
 *                         [--approval-mode <mode>] [--stream-output]
 *                         [--resume-last] [--resume <id>]
 *
 *   -p, --prompt <text>   Required (unless --prompt-file). Prompt text passed
 *                         to gemini-cli stdin.
 *   --prompt-file <path>  Read the prompt body from a file. Takes priority
 *                         over -p/--prompt when both are given. Sidesteps the
 *                         Windows ~32K argv limit (spawn ENAMETOOLONG) for
 *                         large prompts.
 *   --json / --no-json    Emit machine-readable JSON envelope (default: yes).
 *   --write               Forward write capability. Default approval becomes
 *                         `auto_edit` (auto-approve edit tools only); pair with
 *                         --yolo / --approval-mode yolo for full auto-approve.
 *   --yolo                Force `--approval-mode yolo` (auto-approve ALL tools).
 *   --approval-mode <m>   Forward verbatim to gemini-cli. One of:
 *                         default | auto_edit | yolo | plan. Overrides the
 *                         derived default from --write/--yolo. When unset:
 *                         read-only (no --write) → default; --write → auto_edit;
 *                         --write --yolo → yolo.
 *   --model <name>        Forward as `-m <name>` to gemini-cli.
 *   --cwd <path>          spawn cwd override (default: process.cwd()).
 *   --allow-mcp           Re-enable settings.json MCP servers. Default: off
 *                         (gemini-cli is invoked with --allowed-mcp-server-names
 *                         set to a sentinel name that exists in no settings,
 *                         which whitelists nothing → MCP merge is empty).
 *   --stream-output       Switch the CLI to `-o stream-json` (JSONL event
 *                         stream). Each line refreshes the idle clock, so idle
 *                         detection becomes meaningful for long tasks. The
 *                         assistant text is reconstructed from the streamed
 *                         message deltas and token usage is lifted from the
 *                         terminal `result` event. Default stays plain `json`.
 *   --resume-last         Resume the most recent gemini session in this project
 *                         (`-r latest`).
 *   --resume <id|index>   Resume a specific session by id/index (`-r <id>`).
 *                         Takes priority over --resume-last when both given.
 *
 * Compatibility no-ops (accepted but ignored to keep ccgx-call-plugin.mjs and
 * future gemini-companion-shaped callers working):
 *   --background, --wait, --effort <v>, --thinking <v>, --fresh
 *
 * Output envelope (when --json): same shape as gemini-companion task so that
 * any caller already parsing the companion output works unchanged.
 *
 *   {
 *     "status": 0,                       // 0 ok, 1 error
 *     "threadId": "<gemini session id>", // from gemini-cli's session_id
 *     "rawOutput": "<text>",             // from gemini-cli's response field
 *     "touchedFiles": [],                // unsupported in batch mode; empty
 *     "reasoningSummary": [],            // unsupported in batch mode; empty
 *     "durationMs": <number>,
 *     "stats": { ... },                  // gemini-cli stats verbatim (or null)
 *     "error": "<message>"               // present only when status != 0
 *   }
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { applyHomeGeminiAuthEnv } from "./lib/gemini-env.mjs";
import { spawnSafe } from "./lib/process.mjs";

const NO_MCP_SENTINEL = "__ccgx_no_mcp__";

// Hard ceiling on accumulated stdout to mirror the ACP path's 1MiB backpressure
// guard. gemini-cli's JSON payload for a rescue task is KBs; 32MiB is orders of
// magnitude of headroom while still capping a runaway model that streams forever.
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;

// Cap on the stream parser's in-progress line buffer. A JSONL event line is
// KBs; a "line" growing past 8MiB means the CLI is emitting a newline-free
// torrent and the buffer would otherwise grow until OOM — the 32MiB stdout cap
// above does not cover it because the parser keeps its own copy. Over the cap
// the partial line is dropped and counted as a parseError.
const MAX_STREAM_LINE_BUF = 8 * 1024 * 1024;

// Defaults are wide on purpose. gemini-batch is a one-shot wrapper around a
// CLI that internally calls a foundation model — token-stream latency, auth
// refresh, retry storms, and Windows MCP cold-start all eat seconds without
// the process actually being stuck. We use idle (no output for N ms) as the
// primary "stuck" signal and wall-time only as the absolute safety ceiling.
const DEFAULT_TIMEOUT_MS = 7_200_000;        // 2h
// 1.1.2: idle is OPT-IN (default 0) in plain `json` mode. gemini-cli
// --output-format json emits only 4-5 startup warnings, then is silent through
// reasoning + tool calls, then dumps the final JSON. Any positive idle default
// kills healthy long tasks. Wall-time stays the safety net.
//
// 1.3.0 (F5): with --stream-output the CLI emits a JSONL event per step, so
// silence genuinely means stuck. Callers may now set a sane idle on the
// stream path; we keep the default at 0 for backward compatibility but the
// stream parser refreshes lastActivityAt per line so a caller-set idle works.
const DEFAULT_IDLE_TIMEOUT_MS = 0;

function parseArgs(argv) {
  const opts = {
    subcommand: null,
    prompt: null,
    promptFile: null,
    json: true,
    write: false,
    yolo: false,
    approvalMode: null,
    streamOutput: false,
    resumeLast: false,
    resumeId: null,
    model: null,
    cwd: null,
    allowMcp: false,
    mcpAllow: null,
    includeDirectories: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const consumeValue = () => {
      const v = argv[++i];
      if (v === undefined) {
        throw new Error(`flag ${a} requires a value`);
      }
      return v;
    };
    switch (a) {
      case "-p":
      case "--prompt":
        opts.prompt = consumeValue();
        break;
      case "--prompt-file":
        opts.promptFile = consumeValue();
        break;
      case "--json":
        opts.json = true;
        break;
      case "--no-json":
        opts.json = false;
        break;
      case "--write":
        opts.write = true;
        break;
      case "--yolo":
        opts.yolo = true;
        break;
      case "--approval-mode": {
        const v = consumeValue();
        const valid = new Set(["default", "auto_edit", "yolo", "plan"]);
        if (!valid.has(v)) {
          throw new Error(
            `--approval-mode requires one of default|auto_edit|yolo|plan (got '${v}')`,
          );
        }
        opts.approvalMode = v;
        break;
      }
      case "--stream-output":
        opts.streamOutput = true;
        break;
      case "--resume-last":
        opts.resumeLast = true;
        break;
      case "--resume":
        opts.resumeId = consumeValue();
        break;
      case "--model":
        opts.model = consumeValue();
        break;
      case "--cwd":
        opts.cwd = consumeValue();
        break;
      case "--allow-mcp":
        opts.allowMcp = true;
        break;
      // Selective MCP allowlist (comma/space list of real server names). The
      // ccgx integration helper forwards retrieval servers (fast-context /
      // context7) here so they survive the default blanket-suppression while
      // unrelated servers stay off and batch startup stays fast.
      case "--mcp-allow":
        opts.mcpAllow = consumeValue();
        break;
      // Extra read-only workspace dirs (comma/space list) → gemini-cli
      // --include-directories. Used for cross-repo / worktree review.
      case "--include-directories":
        opts.includeDirectories = consumeValue();
        break;
      case "--timeout-ms": {
        const v = Number.parseInt(consumeValue(), 10);
        if (!Number.isFinite(v) || v < 0) {
          throw new Error("--timeout-ms requires a non-negative integer (0 = disable)");
        }
        opts.timeoutMs = v;
        break;
      }
      case "--idle-timeout-ms": {
        const v = Number.parseInt(consumeValue(), 10);
        if (!Number.isFinite(v) || v < 0) {
          throw new Error("--idle-timeout-ms requires a non-negative integer (0 = disable)");
        }
        opts.idleTimeoutMs = v;
        break;
      }
      // Companion-compat no-ops:
      case "--background":
      case "--wait":
      case "--fresh":
        break;
      case "--effort":
      case "--thinking":
        consumeValue();
        break;
      default:
        if (a.startsWith("--")) {
          throw new Error(`unknown flag: ${a}`);
        }
        positional.push(a);
    }
  }
  opts.subcommand = positional[0] ?? null;
  return opts;
}

/**
 * Resolve the gemini-cli `--approval-mode` value from the batch flags.
 *
 * Priority (first-principles, least-privilege by default):
 *   1. explicit --approval-mode wins verbatim (caller knows best).
 *   2. --write --yolo (or --write + --approval-mode unset + --yolo) → yolo.
 *   3. --write alone → auto_edit (auto-approve edit tools; NOT arbitrary shell).
 *   4. no --write (read-only task) → default. NOT `plan`: in gemini-cli's
 *      non-interactive mode `plan` is escapable — ExitPlanModeTool's
 *      getAllowApprovalMode() returns YOLO when !config.isInteractive(), so a
 *      model that calls exit_plan_mode gets its plan auto-approved and the
 *      session escalates to full auto-approve (verified in gemini-cli 0.42
 *      bundle). `default` headlessly auto-rejects every approval-requiring
 *      tool call — writes are denied, which is the closest available
 *      approximation of a no-write guarantee in batch mode.
 */
function resolveApprovalMode(opts) {
  if (opts.approvalMode) return opts.approvalMode;
  if (opts.write) return opts.yolo ? "yolo" : "auto_edit";
  if (opts.yolo) return "yolo"; // --yolo without --write still means full auto
  return "default";
}

/**
 * Resolve the prompt body: --prompt-file (read file content; throws on any
 * unreadable path) beats -p/--prompt. File transport exists because Windows
 * spawn throws ENAMETOOLONG when total argv exceeds ~32K — large review
 * prompts must not travel through argv.
 */
function resolvePrompt(opts) {
  if (opts.promptFile) {
    return fs.readFileSync(opts.promptFile, "utf8");
  }
  return opts.prompt;
}

/**
 * Build the gemini-cli argv from parsed batch opts. Pure: no I/O, no env reads
 * — keeps the flag-translation matrix unit-testable without spawning anything.
 */
function buildCliArgs(opts) {
  const outputFormat = opts.streamOutput ? "stream-json" : "json";
  const cliArgs = ["--output-format", outputFormat];

  // F6: approval mode. Always pass an explicit mode so the privilege level is
  // pinned by us, not by whatever default the CLI build happens to ship.
  cliArgs.push("--approval-mode", resolveApprovalMode(opts));

  if (opts.model) cliArgs.push("-m", opts.model);

  // F4: session resume. Explicit id beats --resume-last (which means "latest").
  // Parallel double-model runs can race on `latest`, so an explicit threadId
  // from a prior envelope should always win when the caller has one.
  if (opts.resumeId) cliArgs.push("-r", opts.resumeId);
  else if (opts.resumeLast) cliArgs.push("-r", "latest");

  // MCP allowlist precedence: an explicit --mcp-allow list wins (forward those
  // real server names), then the blanket --allow-mcp toggle (leave settings.json
  // servers untouched), else suppress all via a sentinel that matches no server.
  if (opts.mcpAllow) {
    cliArgs.push("--allowed-mcp-server-names", opts.mcpAllow);
  } else if (!opts.allowMcp) {
    // settings.json MCP servers are merged unconditionally inside gemini-cli's
    // newSession; the only public knob to suppress them is the allowlist.
    // A sentinel name that matches no real server effectively empties the
    // merged MCP set without touching the user's settings.json.
    cliArgs.push("--allowed-mcp-server-names", NO_MCP_SENTINEL);
  }

  // C9: extra read-only workspace dirs forwarded verbatim to gemini-cli.
  if (opts.includeDirectories) {
    cliArgs.push("--include-directories", opts.includeDirectories);
  }

  // F7: trust the cwd for this session (cures the env-bridge root cause:
  // gemini-cli skips project-level config in an untrusted folder) and disable
  // all extensions (-e none → empty array) so a fresh-context subagent prompt
  // stays pure / reproducible. Note --skip-trust deliberately weakens the
  // folder-trust boundary for the spawned session: required to avoid the
  // non-interactive trust prompt hanging batch runs, acceptable because the
  // cwd is always a workspace the caller already operates in.
  cliArgs.push("--skip-trust");
  cliArgs.push("-e", "none");

  return cliArgs;
}

function emitEnvelope(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function emitError(message, durationMs = 0) {
  emitEnvelope({
    status: 1,
    threadId: null,
    rawOutput: "",
    touchedFiles: [],
    reasoningSummary: [],
    durationMs,
    stats: null,
    error: message,
  });
  process.exit(1);
}

/**
 * Best-effort kill of the child + entire descendant tree.
 *
 * Why a tree kill: on Windows spawnSafe wraps the resolved `gemini.cmd` shim
 * in cmd.exe, so child.pid is cmd.exe and the real gemini-cli node process is
 * a grandchild. Sending SIGTERM to the direct child terminates only cmd.exe
 * and leaves gemini-cli running — orphaned, still holding the model session,
 * and accumulating arbitrary cost. `taskkill /T /F` walks the descendant tree
 * by ParentProcessId and force-kills each, so the cmd.exe wrapper pid still
 * covers the whole tree.
 *
 * On POSIX SIGTERM propagates via process group when we use the same
 * lineage; the `kill -- -pgid` path would be needed for true tree kill,
 * but the cmd.exe wrap is win32-only so the POSIX path keeps SIGTERM.
 */
function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    // /T: include descendants. /F: force. spawnSync so we don't race the
    // exit handler. windowsHide keeps the console flicker-free.
    try {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      // Fall through to SIGKILL — at least the direct child dies.
    }
  }
  try { child.kill("SIGTERM"); } catch { /* ignore */ }
  // SIGKILL backstop in case SIGTERM is ignored (cmd.exe sometimes does).
  setTimeout(() => {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
  }, 5000).unref?.();
}

/**
 * Extract the first complete, balanced JSON object from a stdout buffer.
 *
 * gemini-cli writes warnings ("Warning: True color...", "YOLO mode...",
 * "Ripgrep is not available", "MCP issues detected") to stdout BEFORE and
 * sometimes AFTER the JSON payload, on bare lines without separators. A naive
 * `JSON.parse(stdout.slice(indexOf('{')))` throws on any trailing text. We
 * instead scan from the first '{' tracking brace depth (ignoring braces inside
 * string literals) and return the slice that closes the first balanced object.
 */
function extractJsonPayload(stdout) {
  const start = stdout.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stdout.length; i++) {
    const ch = stdout[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = stdout.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null; // never closed → truncated / not JSON
}

/**
 * Incremental parser for `-o stream-json` JSONL output.
 *
 * Real event shapes (captured from gemini-cli 0.42, `-o stream-json`):
 *   {"type":"init","session_id":"...","model":"..."}
 *   {"type":"message","role":"user","content":"..."}
 *   {"type":"message","role":"assistant","content":"ok","delta":true}
 *   {"type":"tool_use", ...}        // tool invocation (when tools run)
 *   {"type":"tool_result", ...}     // tool output (when tools run)
 *   {"type":"result","status":"success","stats":{total_tokens,input_tokens,
 *                                                 output_tokens,cached,
 *                                                 duration_ms,tool_calls,...}}
 *
 * We feed it raw stdout chunks; it buffers partial lines, parses each complete
 * JSONL line, and accumulates state. The caller drains finished state after the
 * process exits.
 */
function createStreamParser({ onActivity, onEvent } = {}) {
  let buf = "";
  const state = {
    sessionId: null,
    model: null,
    assistantText: "",
    status: null,
    stats: null,
    events: [], // compact summaries for optional persistence
    parseErrors: 0,
  };

  function ingestLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      // Non-JSON line (a stray warning leaked onto stdout). Ignore but count.
      state.parseErrors++;
      return;
    }
    onActivity?.();
    switch (evt.type) {
      case "init":
        if (evt.session_id) state.sessionId = evt.session_id;
        if (evt.model) state.model = evt.model;
        break;
      case "message":
        if (evt.role === "assistant" && typeof evt.content === "string") {
          // delta:true → token chunk to append; absent/false → full message.
          if (evt.delta) state.assistantText += evt.content;
          else state.assistantText = evt.content;
        }
        break;
      case "tool_use":
      case "tool_result":
        // Surfaced only as activity + compact summary; not part of rawOutput.
        break;
      case "result":
        if (evt.status) state.status = evt.status;
        if (evt.stats) state.stats = evt.stats;
        break;
      default:
        break;
    }
    const summary = {
      type: evt.type,
      role: evt.role ?? undefined,
      ts: evt.timestamp ?? undefined,
    };
    state.events.push(summary);
    onEvent?.(evt, summary);
  }

  return {
    state,
    /** Feed a raw stdout chunk; parses any complete lines it completes. */
    push(chunk) {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        ingestLine(line);
      }
      // Newline-free torrent guard: drop a partial line that outgrows the cap
      // so the parser's private buffer cannot bypass the 32MiB stdout ceiling.
      if (buf.length > MAX_STREAM_LINE_BUF) {
        buf = "";
        state.parseErrors++;
      }
    },
    /** Flush any trailing partial line at EOF (CLI may omit final newline). */
    end() {
      if (buf.length) {
        ingestLine(buf);
        buf = "";
      }
    },
  };
}

async function main() {
  // Bridge ~/.gemini/.env auth keys past gemini-cli's folder-trust gate so the
  // spawned gemini (env: process.env) is authenticated. See lib/gemini-env.mjs.
  // F7: --skip-trust below makes the untrusted-cwd folder-trust gate a non-issue
  // for project-level config, but we keep the env bridge as a fallback so auth
  // still works on CLI builds that gate env loading independently of trust.
  applyHomeGeminiAuthEnv();

  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    emitError(`arg parse: ${err.message}`);
    return;
  }

  if (opts.subcommand !== "task") {
    emitError(
      `unsupported subcommand '${opts.subcommand ?? "<none>"}'. ` +
        `Only 'task' is supported (gemini-batch is a drop-in for ` +
        `gemini-companion.mjs task, no other modes).`,
    );
    return;
  }
  let prompt;
  try {
    prompt = resolvePrompt(opts);
  } catch (err) {
    emitError(`--prompt-file: cannot read '${opts.promptFile}': ${err.message}`);
    return;
  }
  if (!prompt) {
    emitError(
      "missing required -p <prompt> (or --prompt <prompt> / --prompt-file <path>).",
    );
    return;
  }

  const cliArgs = buildCliArgs(opts);

  const startedAt = Date.now();
  // spawnSafe resolves the `gemini` .cmd shim to an absolute path and wraps it
  // in cmd.exe with every arg cmdEscapeArg-quoted — never `shell: true`, which
  // performs no escaping and turns model/caller-controlled argv (model name,
  // include dirs) into a cmd.exe injection surface. stdin/stdout/stderr pipes
  // behave identically: cmd.exe passes the stdio handles through to gemini.
  const child = spawnSafe("gemini", cliArgs, {
    cwd: opts.cwd ?? process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  let stdoutTruncated = false;
  let lastActivityAt = Date.now();
  const markActivity = () => { lastActivityAt = Date.now(); };

  // F5: in stream mode, parse JSONL incrementally so each event refreshes the
  // idle clock and we can lift assistant text + token stats from the stream.
  const streamParser = opts.streamOutput
    ? createStreamParser({ onActivity: markActivity })
    : null;

  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    // F8: bound the buffer. Once over the cap, stop accumulating (keep what we
    // have for a best-effort parse) but keep feeding the stream parser, which
    // holds only a single partial line, not the whole transcript.
    if (!stdoutTruncated) {
      if (stdoutBuf.length + chunk.length > MAX_STDOUT_BYTES) {
        stdoutBuf += chunk.slice(0, MAX_STDOUT_BYTES - stdoutBuf.length);
        stdoutTruncated = true;
      } else {
        stdoutBuf += chunk;
      }
    }
    streamParser?.push(chunk);
    markActivity();
  });
  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk;
    markActivity();
  });

  // Pipe the prompt body in over stdin then close it so gemini-cli sees EOF
  // and enters single-turn mode.
  child.stdin.end(prompt);

  // Two-layer kill: idle (silence) is the primary "stuck" detector; wall-time
  // is the absolute safety ceiling. Either fires → killProcessTree → the
  // exit Promise resolves naturally and we report the cause.
  let killed = false;
  let killReason = null;
  const triggerKill = (reason) => {
    if (killed) return;
    killed = true;
    killReason = reason;
    killProcessTree(child);
  };
  const wallTimer = opts.timeoutMs > 0
    ? setTimeout(() => triggerKill(`wall-time ${opts.timeoutMs}ms`), opts.timeoutMs)
    : null;
  const idleChecker = opts.idleTimeoutMs > 0
    ? setInterval(() => {
        const silent = Date.now() - lastActivityAt;
        if (silent >= opts.idleTimeoutMs) {
          triggerKill(`idle ${silent}ms exceeds ${opts.idleTimeoutMs}ms`);
        }
      }, 30000)
    : null;
  idleChecker?.unref?.();
  wallTimer?.unref?.();

  const exit = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (err) =>
      resolve({ code: 1, signal: null, errorMsg: err.message }),
    );
  });

  if (wallTimer) clearTimeout(wallTimer);
  if (idleChecker) clearInterval(idleChecker);
  streamParser?.end();
  const durationMs = Date.now() - startedAt;

  if (killed) {
    const tail = stderrBuf.length > 800 ? stderrBuf.slice(-800) : stderrBuf;
    emitError(
      `gemini-cli killed (${killReason})` + (tail ? `: ${tail.trim()}` : ""),
      durationMs,
    );
    return;
  }

  if (exit.code !== 0) {
    const tail = stderrBuf.length > 800 ? stderrBuf.slice(-800) : stderrBuf;
    emitError(
      `gemini-cli exited ${exit.code}` +
        (exit.errorMsg ? ` (${exit.errorMsg})` : "") +
        (tail ? `: ${tail.trim()}` : ""),
      durationMs,
    );
    return;
  }

  // Build the envelope from whichever parse path was active.
  let envelope;
  if (streamParser) {
    const s = streamParser.state;
    if (!s.sessionId && !s.assistantText && !s.stats) {
      emitError(
        `gemini-cli stream produced no usable events. ` +
          `stdout head: ${stdoutBuf.slice(0, 400)} ` +
          `stderr tail: ${stderrBuf.slice(-400)}`,
        durationMs,
      );
      return;
    }
    envelope = {
      status: 0,
      threadId: s.sessionId ?? null,
      rawOutput: s.assistantText,
      touchedFiles: [],
      reasoningSummary: [],
      durationMs,
      stats: s.stats ?? null,
    };
  } else {
    const parsed = extractJsonPayload(stdoutBuf);
    if (!parsed) {
      emitError(
        `gemini-cli produced no parseable JSON payload` +
          (stdoutTruncated ? ` (stdout truncated at ${MAX_STDOUT_BYTES} bytes)` : "") +
          `. stdout head: ${stdoutBuf.slice(0, 400)} ` +
          `stderr tail: ${stderrBuf.slice(-400)}`,
        durationMs,
      );
      return;
    }
    envelope = {
      status: 0,
      threadId: parsed.session_id ?? null,
      rawOutput: typeof parsed.response === "string" ? parsed.response : "",
      touchedFiles: [],
      reasoningSummary: [],
      durationMs,
      stats: parsed.stats ?? null,
    };
  }

  if (opts.json) {
    emitEnvelope(envelope);
  } else {
    process.stdout.write(envelope.rawOutput);
  }
  process.exit(0);
}

// Entry point — only run main() when invoked as a script (not on import),
// mirroring ccgx-call-plugin.mjs so the test surface below is importable.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const here = fileURLToPath(import.meta.url);
    const entry = path.resolve(process.argv[1]);
    if (here === entry) return true;
    // win32 paths are case-insensitive; argv[1] may also arrive with forward
    // slashes (path.resolve fixes those, not case). A false negative here is a
    // silent no-op CLI, so compare case-folded.
    return process.platform === "win32" && here.toLowerCase() === entry.toLowerCase();
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    emitError(`gemini-batch crashed: ${err?.stack ?? err}`);
  });
}

// Test surface for unit tests.
export const __testing = {
  parseArgs,
  resolveApprovalMode,
  resolvePrompt,
  buildCliArgs,
  createStreamParser,
  NO_MCP_SENTINEL,
  MAX_STREAM_LINE_BUF,
};
