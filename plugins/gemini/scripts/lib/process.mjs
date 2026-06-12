/**
 * Process spawning and management utilities.
 */

import { execFileSync, spawnSync, spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const IS_WINDOWS = process.platform === "win32";

/**
 * Resolve a bare command name to its absolute executable path on Windows.
 *
 * Why this exists:
 *   `gemini` (and `npm`, `git`, ...) ship on Windows as `gemini.cmd` / `.ps1`
 *   shims, not a bare `gemini.exe`. Node's spawn / spawnSync does NOT consult
 *   PATHEXT, so `spawnSync("gemini", ...)` ENOENTs even when gemini is on PATH.
 *   getGeminiAvailability() then reports "not available", which on the Stop
 *   review gate means the gate silently fails OPEN (review never runs) on every
 *   Windows install. We mirror Go's exec.LookPath: walk PATH × PATHEXT and stat
 *   each candidate, returning the first real file.
 *
 *   We deliberately do NOT use `shell: true` to fix this: the stop-review gate
 *   places an entire model response into argv via `-p`, and shell mode performs
 *   no argument escaping — that turns arbitrary session content into a cmd.exe
 *   command-injection surface. Resolving an absolute path + spawning with
 *   shell:false (the default) keeps args verbatim and safe.
 *
 * @param {string} cmd
 * @param {{ env?: NodeJS.ProcessEnv, statFn?: (p: string) => fs.Stats }} [opts]
 * @returns {string} resolved absolute path, or `cmd` unchanged when not resolvable
 */
export function resolveWindowsCommand(cmd, opts = {}) {
  if (!IS_WINDOWS) return cmd;
  if (path.isAbsolute(cmd) || cmd.includes("/") || cmd.includes("\\")) return cmd;
  const env = opts.env || process.env;
  const stat = opts.statFn || fs.statSync;
  const pathExt = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";").map((s) => s.trim()).filter(Boolean);
  // An extensionless name (e.g. `gemini`) is never directly executable on
  // Windows — it must match a PATHEXT entry. Only when the name already has a
  // dot do we also try the raw form.
  const hasDot = cmd.includes(".");
  const candidates = hasDot ? [cmd, ...pathExt.map((e) => cmd + e)] : pathExt.map((e) => cmd + e);
  const dirs = (env.PATH || env.Path || "").split(";").filter(Boolean);
  // CreateProcess searches the current directory first, then PATH.
  for (const dir of ["", ...dirs]) {
    for (const c of candidates) {
      const full = dir ? path.join(dir, c) : c;
      try {
        const info = stat(full);
        if (info && info.isFile && info.isFile()) return full;
      } catch { /* not found, keep scanning */ }
    }
  }
  return cmd; // let spawn surface ENOENT
}

/**
 * Render one argument for a `cmd.exe /d /s /c "<line>"` invocation made with
 * `windowsVerbatimArguments: true`, neutralizing cmd.exe command injection.
 *
 * Why this is mandatory (not a nicety):
 *   With windowsVerbatimArguments Node hands the line to CreateProcess with
 *   ZERO quoting. The spawned process is cmd.exe, which re-parses that line and
 *   interprets metacharacters — `& | < > ( ) ^ % "` — in any UNQUOTED argument.
 *   The gemini stop-review gate places an entire (model-influenced) Claude
 *   response into argv via `-p`, so an un-escaped argument like
 *   `review & calc.exe` would break out of the gemini call and run a chained
 *   cmd.exe command. `shell:false` on the cmd.exe process does not help — here
 *   cmd.exe IS the shell.
 *
 * Algorithm (port of Rust std's append_bat_arg for the .bat/.cmd CVE fix,
 * empirically validated against cmd.exe on Windows):
 *   - Wrap the arg in literal double quotes so cmd.exe sees a quoted span where
 *     `& | < > ( )` are inert, and so the target program's MSVCRT parser gets a
 *     single token (spaces/empty-string preserved).
 *   - `"` in the payload → emit `\"` (MSVCRT escape). The arg stays one token
 *     to the target; cmd.exe cannot be tricked into executing a chained command
 *     (verified: every embedded-quote+metachar breakout attempt fails closed).
 *   - `%` → emit `"^%"` (close span, caret-% , reopen) so cmd.exe does not
 *     expand `%VAR%`.
 *   - Runs of `\` before a `"` (or the closing quote) are MSVCRT-doubled.
 *
 * Note: the resolved `.cmd` path itself is NOT passed through here — it comes
 * from fixed PATH/PATHEXT resolution of a constant command name, not from
 * caller/model input, so it carries no injection risk.
 *
 * @param {string} arg
 * @returns {string}
 */
export function cmdEscapeArg(arg) {
  let out = '"';
  let backslashes = 0;
  for (const ch of String(arg)) {
    if (ch === "%") { out += '"^%"'; backslashes = 0; continue; }
    if (ch === '"') { out += "\\".repeat(backslashes) + '\\"'; backslashes = 0; continue; }
    if (ch === "\\") { backslashes += 1; out += ch; continue; }
    backslashes = 0;
    out += ch;
  }
  out += "\\".repeat(backslashes) + '"';
  return out;
}

/**
 * Build the [command, args, extraOpts] to spawn `command` safely on Windows.
 *
 * Resolves bare names via PATHEXT, then for a resolved `.cmd`/`.bat` wraps the
 * call in `cmd.exe /d /s /c "<path> <args...>"` with windowsVerbatimArguments
 * (Node ≥18 throws EINVAL when spawning .cmd/.bat directly — CVE-2024-27980
 * mitigation). Because windowsVerbatimArguments hands the line to cmd.exe with
 * no quoting, every caller-supplied arg is run through cmdEscapeArg() and the
 * whole `"<path> <args>"` is wrapped in one outer quote pair that `/s` strips,
 * so cmd.exe cannot interpret metacharacters in argv content (command
 * injection).
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ command: string, args: string[], extraOpts: Record<string, unknown> }}
 */
function buildSafeSpawn(command, args, options = {}) {
  if (!IS_WINDOWS) return { command, args, extraOpts: {} };
  const resolved = resolveWindowsCommand(command, { env: options.env });
  if (/\.(cmd|bat)$/i.test(resolved)) {
    const line = [`"${resolved}"`, ...args.map(cmdEscapeArg)].join(" ");
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `"${line}"`],
      extraOpts: { windowsVerbatimArguments: true }
    };
  }
  return { command: resolved, args, extraOpts: {} };
}

/**
 * spawn() drop-in that routes through buildSafeSpawn so no caller ever needs
 * `shell: true` to launch a Windows `.cmd`/`.bat` shim. Same injection
 * guarantees as runCommand: args reach the target verbatim, cmd.exe never
 * interprets argv metacharacters. On non-win32 this is a plain spawn.
 *
 * `options` is passed through to node's spawn (stdio, cwd, detached,
 * windowsHide, ...); `windowsVerbatimArguments` is owned by this wrapper and
 * must not be supplied by callers.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {import("node:child_process").SpawnOptions} [options]
 * @returns {import("node:child_process").ChildProcess}
 */
export function spawnSafe(command, args, options = {}) {
  const env = options.env ?? process.env;
  const safe = buildSafeSpawn(command, args, { env });
  return nodeSpawn(safe.command, safe.args, { ...options, env, ...safe.extraOpts });
}

/**
 * Run a command synchronously and return the result.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, maxBuffer?: number, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ stdout: string, stderr: string, status: number | null, error: Error | null }}
 */
export function runCommand(command, args, options = {}) {
  try {
    const env = options.env ?? process.env;
    const safe = buildSafeSpawn(command, args, { env });
    const result = spawnSync(safe.command, safe.args, {
      cwd: options.cwd,
      maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
      encoding: "utf8",
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...safe.extraOpts
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status,
      error: result.error ?? null
    };
  } catch (/** @type {any} */ error) {
    return {
      stdout: "",
      stderr: error.message ?? "",
      status: 1,
      error
    };
  }
}

/**
 * Run a command synchronously and throw on non-zero exit.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, maxBuffer?: number, env?: NodeJS.ProcessEnv }} [options]
 * @returns {string} stdout
 */
export function runCommandChecked(command, args, options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result.stdout;
}

/**
 * Format a failed command result into a human-readable error message.
 *
 * @param {{ stdout: string, stderr: string, status: number | null }} result
 * @returns {string}
 */
export function formatCommandFailure(result) {
  const parts = [`Command exited with status ${result.status ?? "unknown"}.`];
  const stderr = (result.stderr ?? "").trim();
  if (stderr) {
    parts.push(`stderr: ${stderr}`);
  }
  return parts.join("\n");
}

/**
 * Check whether a binary is available on PATH.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function binaryAvailable(name) {
  try {
    const command = IS_WINDOWS ? "where" : "which";
    const result = spawnSync(command, [name], { encoding: "utf8", stdio: "pipe", windowsHide: true });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Terminate a process and its children.
 *
 * @param {number} pid
 */
export function terminateProcessTree(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }

  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      // Try SIGTERM on the process group first.
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }

      // Follow up with SIGKILL after a short delay.
      setTimeout(() => {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Process already exited.
        }
      }, 500);
    }
  } catch {
    // Process may already be gone.
  }
}

/**
 * Spawn a detached child process that outlives the parent.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, logFile?: string }} [options]
 * @returns {import("node:child_process").ChildProcess}
 */
export function spawnDetached(command, args, options = {}) {
  let logFd = null;
  try {
    logFd = options.logFile ? fs.openSync(options.logFile, "a") : null;
    const stdio = options.logFile
      ? ["ignore", "ignore", logFd]
      : ["ignore", "ignore", "ignore"];

    const child = nodeSpawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: true,
    windowsHide: true,
      stdio
    });

    child.unref();
    return child;
  } finally {
    if (typeof logFd === "number") {
      fs.closeSync(logFd);
    }
  }
}
