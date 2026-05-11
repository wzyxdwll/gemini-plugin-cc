#!/usr/bin/env node

/**
 * gemini-batch.mjs — non-interactive batch entry point for the gemini-plugin-cc
 * fork. Drop-in alternative to `gemini-companion.mjs task` that bypasses the
 * ACP broker layer entirely and drives the upstream `gemini` CLI in batch mode
 * via stdin + `--output-format json`.
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
 *   gemini-batch.mjs task -p <prompt> [--json|--no-json] [--write]
 *                         [--model <name>] [--cwd <path>] [--allow-mcp]
 *
 *   -p, --prompt <text>   Required. Prompt text passed to gemini-cli stdin.
 *   --json / --no-json    Emit machine-readable JSON envelope (default: yes).
 *   --write               Forward as `--yolo` to gemini-cli (auto-approve
 *                         shell tool calls). Mirrors codex --write semantics.
 *   --model <name>        Forward as `-m <name>` to gemini-cli.
 *   --cwd <path>          spawn cwd override (default: process.cwd()).
 *   --allow-mcp           Re-enable settings.json MCP servers. Default: off
 *                         (gemini-cli is invoked with --allowed-mcp-server-names
 *                         set to a sentinel name that exists in no settings,
 *                         which whitelists nothing → MCP merge is empty).
 *
 * Compatibility no-ops (accepted but ignored to keep ccgx-call-plugin.mjs and
 * future gemini-companion-shaped callers working):
 *   --background, --wait, --resume-last, --stream-output, --effort <v>,
 *   --approval-mode <v>, --thinking <v>
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

import { spawn } from "node:child_process";
import process from "node:process";

const NO_MCP_SENTINEL = "__ccgx_no_mcp__";

function parseArgs(argv) {
  const opts = {
    subcommand: null,
    prompt: null,
    json: true,
    write: false,
    model: null,
    cwd: null,
    allowMcp: false,
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
      case "--json":
        opts.json = true;
        break;
      case "--no-json":
        opts.json = false;
        break;
      case "--write":
        opts.write = true;
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
      // Companion-compat no-ops:
      case "--background":
      case "--wait":
      case "--resume-last":
      case "--stream-output":
        break;
      case "--effort":
      case "--approval-mode":
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
 * gemini-cli writes warnings ("Warning: True color...", "YOLO mode...",
 * "Ripgrep is not available", "MCP issues detected") to stdout BEFORE the
 * JSON payload, all on one or two lines without separators. Find the first
 * '{' that opens a balanced JSON object at the tail.
 */
function extractJsonPayload(stdout) {
  const start = stdout.indexOf("{");
  if (start === -1) return null;
  const candidate = stdout.slice(start);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

async function main() {
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
  if (!opts.prompt) {
    emitError("missing required -p <prompt> (or --prompt <prompt>).");
    return;
  }

  const cliArgs = ["--output-format", "json"];
  if (opts.write) cliArgs.push("--yolo");
  if (opts.model) cliArgs.push("-m", opts.model);
  if (!opts.allowMcp) {
    // settings.json MCP servers are merged unconditionally inside gemini-cli's
    // newSession; the only public knob to suppress them is the allowlist.
    // A sentinel name that matches no real server effectively empties the
    // merged MCP set without touching the user's settings.json.
    cliArgs.push("--allowed-mcp-server-names", NO_MCP_SENTINEL);
  }

  const startedAt = Date.now();
  const child = spawn("gemini", cliArgs, {
    cwd: opts.cwd ?? process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    // Windows: `gemini` is a .cmd shim — must go through cmd.exe.
    shell: process.platform === "win32",
    windowsHide: true,
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk;
  });

  // Pipe the prompt body in over stdin then close it so gemini-cli sees EOF
  // and enters single-turn mode.
  child.stdin.end(opts.prompt);

  const exit = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (err) =>
      resolve({ code: 1, signal: null, errorMsg: err.message }),
    );
  });

  const durationMs = Date.now() - startedAt;

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

  const parsed = extractJsonPayload(stdoutBuf);
  if (!parsed) {
    emitError(
      `gemini-cli produced no parseable JSON payload. ` +
        `stdout head: ${stdoutBuf.slice(0, 400)} ` +
        `stderr tail: ${stderrBuf.slice(-400)}`,
      durationMs,
    );
    return;
  }

  const envelope = {
    status: 0,
    threadId: parsed.session_id ?? null,
    rawOutput: typeof parsed.response === "string" ? parsed.response : "",
    touchedFiles: [],
    reasoningSummary: [],
    durationMs,
    stats: parsed.stats ?? null,
  };

  if (opts.json) {
    emitEnvelope(envelope);
  } else {
    process.stdout.write(envelope.rawOutput);
  }
  process.exit(0);
}

main().catch((err) => {
  emitError(`gemini-batch crashed: ${err?.stack ?? err}`);
});
