import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { __testing } from "../plugins/gemini/scripts/gemini-batch.mjs";
import { spawnSafe } from "../plugins/gemini/scripts/lib/process.mjs";

const {
  parseArgs,
  resolveApprovalMode,
  resolvePrompt,
  buildCliArgs,
  createStreamParser,
  NO_MCP_SENTINEL,
  MAX_STREAM_LINE_BUF,
} = __testing;

const IS_WINDOWS = process.platform === "win32";

function batchOpts(extraFlags = []) {
  return parseArgs(["task", "-p", "x", ...extraFlags]);
}

/** Value of `--flag <value>` inside an argv array, or null when absent. */
function flagValue(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

// --- approval-mode priority matrix ------------------------------------------

test("explicit --approval-mode wins over --write/--yolo", () => {
  const o = batchOpts(["--approval-mode", "plan", "--write", "--yolo"]);
  assert.equal(resolveApprovalMode(o), "plan");
  const o2 = batchOpts(["--approval-mode", "default", "--write", "--yolo"]);
  assert.equal(resolveApprovalMode(o2), "default");
});

test("--write --yolo resolves to yolo", () => {
  assert.equal(resolveApprovalMode(batchOpts(["--write", "--yolo"])), "yolo");
});

test("--write alone resolves to auto_edit", () => {
  assert.equal(resolveApprovalMode(batchOpts(["--write"])), "auto_edit");
});

test("--yolo without --write still resolves to yolo", () => {
  assert.equal(resolveApprovalMode(batchOpts(["--yolo"])), "yolo");
});

test("read-only default resolves to default, NOT plan (non-interactive plan escapes to YOLO via exit_plan_mode)", () => {
  assert.equal(resolveApprovalMode(batchOpts()), "default");
  // And the resolved mode is what actually lands on the CLI argv.
  assert.equal(flagValue(buildCliArgs(batchOpts()), "--approval-mode"), "default");
});

test("--approval-mode rejects values outside default|auto_edit|yolo|plan", () => {
  assert.throws(() => batchOpts(["--approval-mode", "nope"]), /--approval-mode requires one of/);
});

// --- C8: MCP allowlist three branches ----------------------------------------

test("--mcp-allow forwards the explicit server list (beats --allow-mcp)", () => {
  const args = buildCliArgs(batchOpts(["--mcp-allow", "fast-context,context7", "--allow-mcp"]));
  assert.equal(flagValue(args, "--allowed-mcp-server-names"), "fast-context,context7");
});

test("--allow-mcp alone leaves settings.json servers untouched (no allowlist flag)", () => {
  const args = buildCliArgs(batchOpts(["--allow-mcp"]));
  assert.equal(args.includes("--allowed-mcp-server-names"), false);
});

test("default suppresses all MCP servers via the sentinel allowlist", () => {
  const args = buildCliArgs(batchOpts());
  assert.equal(flagValue(args, "--allowed-mcp-server-names"), NO_MCP_SENTINEL);
});

// --- C9: --include-directories ------------------------------------------------

test("--include-directories is forwarded verbatim only when set", () => {
  const dirs = "D:\\repo a,D:\\repo b";
  const withDirs = buildCliArgs(batchOpts(["--include-directories", dirs]));
  assert.equal(flagValue(withDirs, "--include-directories"), dirs);
  const without = buildCliArgs(batchOpts());
  assert.equal(without.includes("--include-directories"), false);
});

// --- F7 invariants -------------------------------------------------------------

test("--skip-trust and -e none are always present", () => {
  for (const flags of [[], ["--write"], ["--allow-mcp"], ["--stream-output"]]) {
    const args = buildCliArgs(batchOpts(flags));
    assert.equal(args.includes("--skip-trust"), true);
    assert.equal(flagValue(args, "-e"), "none");
  }
});

// --- --prompt-file ---------------------------------------------------------------

test("parseArgs accepts --prompt-file as a value option", () => {
  const o = parseArgs(["task", "--prompt-file", "body.md"]);
  assert.equal(o.promptFile, "body.md");
  assert.throws(() => parseArgs(["task", "--prompt-file"]), /requires a value/);
});

test("resolvePrompt: --prompt-file content beats -p when both are given", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-batch-prompt-"));
  try {
    const file = path.join(dir, "body.md");
    fs.writeFileSync(file, "file prompt body");
    const o = parseArgs(["task", "-p", "inline prompt", "--prompt-file", file]);
    assert.equal(resolvePrompt(o), "file prompt body");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolvePrompt: falls back to -p when no --prompt-file", () => {
  assert.equal(resolvePrompt(batchOpts()), "x");
});

test("resolvePrompt: missing --prompt-file path throws (fail fast, no silent empty prompt)", () => {
  const o = parseArgs(["task", "-p", "inline", "--prompt-file", path.join(os.tmpdir(), "definitely-missing-prompt-file.md")]);
  assert.throws(() => resolvePrompt(o), /ENOENT/);
});

// --- stream parser line-buffer cap ----------------------------------------------

test("createStreamParser drops a newline-free line over the cap and counts a parseError", () => {
  const p = createStreamParser();
  p.push('{"type":"init","session_id":"s1"}\n');
  p.push("x".repeat(MAX_STREAM_LINE_BUF + 1));
  assert.equal(p.state.parseErrors, 1);
  // Parser stays functional after the drop: later complete lines still parse.
  p.push('\n{"type":"result","status":"success","stats":{"total_tokens":7}}\n');
  p.end();
  assert.equal(p.state.sessionId, "s1");
  assert.deepEqual(p.state.stats, { total_tokens: 7 });
});

// --- win32 spawn-path injection regression ----------------------------------------
// Mirrors tests/process.test.mjs's .cmd shim pattern, but exercises the exact
// pipeline gemini-batch uses: buildCliArgs(opts) → spawnSafe with stdio pipes.

async function withCmdShim(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-batch-inject-"));
  try {
    const printer = path.join(dir, "printargs.mjs");
    fs.writeFileSync(
      printer,
      'import fs from "node:fs";\n' +
        "for (const a of process.argv.slice(2)) console.log(JSON.stringify(a));\n" +
        'let body = ""; try { body = fs.readFileSync(0, "utf8"); } catch {}\n' +
        "console.log(JSON.stringify({ stdin: body }));\n",
    );
    const shim = path.join(dir, "faketool.cmd");
    fs.writeFileSync(shim, '@echo off\r\nnode "' + printer + '" %*\r\n');
    const env = {
      ...process.env,
      PATH: dir + ";" + (process.env.PATH || ""),
      Path: dir + ";" + (process.env.Path || ""),
    };
    // Await before the finally-cleanup — the callback spawns asynchronously
    // and the shim must still exist when the child starts.
    return await fn({ dir, env });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function runShim(args, env, stdinBody) {
  const child = spawnSafe("faketool", args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => { out += c; });
  child.stdin.end(stdinBody);
  await new Promise((resolve) => child.once("exit", resolve));
  const lines = out.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const tail = lines.pop(); // { stdin: ... } sentinel printed last
  return { argv: lines, stdin: tail?.stdin ?? "" };
}

test("gemini-batch win32 spawn: metacharacters in --model/--include-directories cannot chain a command", { skip: !IS_WINDOWS }, async () => {
  await withCmdShim(async ({ dir, env }) => {
    const marker = path.join(dir, "PWNED");
    const o = batchOpts([
      "--model", 'gem & echo x> "' + marker + '"',
      "--include-directories", "dir with space %PATH% & more",
    ]);
    const cliArgs = buildCliArgs(o);
    const r = await runShim(cliArgs, env, "prompt body");
    // The chained `& echo > file` must never run.
    assert.equal(fs.existsSync(marker), false);
    // Every arg arrives verbatim — no splitting on &, no %PATH% expansion.
    assert.deepEqual(r.argv, cliArgs);
    // The cmd.exe wrap still pipes stdin through to the target (prompt feed).
    assert.equal(r.stdin, "prompt body");
  });
});

test("gemini-batch win32 spawn: pipes/redirects/spaces in argv stay literal", { skip: !IS_WINDOWS }, async () => {
  await withCmdShim(async ({ env }) => {
    const o = batchOpts(["--mcp-allow", "a|b>c<d", "--model", "name with spaces"]);
    const cliArgs = buildCliArgs(o);
    const r = await runShim(cliArgs, env, "");
    assert.deepEqual(r.argv, cliArgs);
  });
});

test("gemini-batch win32 spawn: embedded-quote breakout fails closed (no execution)", { skip: !IS_WINDOWS }, async () => {
  await withCmdShim(async ({ dir, env }) => {
    const marker = path.join(dir, "PWNED2");
    // Same contract as tests/process.test.mjs: cmd.exe may refuse to invoke the
    // shim for an embedded-quote payload, but the chained command never runs.
    const o = batchOpts(["--model", 'quo"te & echo x> "' + marker + '"']);
    await runShim(buildCliArgs(o), env, "");
    assert.equal(fs.existsSync(marker), false);
  });
});
