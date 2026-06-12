import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommand, binaryAvailable, formatCommandFailure, spawnDetached, cmdEscapeArg } from "../plugins/gemini/scripts/lib/process.mjs";

const IS_WINDOWS = process.platform === "win32";

// Build a .cmd shim on a temp PATH so runCommand resolves it and exercises the
// live cmd.exe-wrapping branch of buildSafeSpawn (Windows only).
function withCmdShim(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-cmd-inject-"));
  try {
    const printer = path.join(dir, "printargs.mjs");
    fs.writeFileSync(printer, "for (const a of process.argv.slice(2)) console.log(JSON.stringify(a));");
    const shim = path.join(dir, "faketool.cmd");
    fs.writeFileSync(shim, '@echo off\r\nnode "' + printer + '" %*\r\n');
    const env = {
      ...process.env,
      PATH: dir + ";" + (process.env.PATH || ""),
      Path: dir + ";" + (process.env.Path || "")
    };
    const call = (args) => {
      const r = runCommand("faketool", args, { env });
      let argv = [];
      try { argv = r.stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch { /* leave empty */ }
      return { ...r, argv };
    };
    return fn({ dir, call });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("runCommand captures stdout and stderr", () => {
  const result = runCommand("node", ["-e", 'process.stdout.write("hello")']);
  assert.equal(result.stdout, "hello");
  assert.equal(result.status, 0);
  assert.equal(result.error, null);
});

test("runCommand returns non-zero exit code without throwing", () => {
  const result = runCommand("node", ["-e", "process.exit(42)"]);
  assert.equal(result.status, 42);
  assert.equal(result.error, null);
});

test("formatCommandFailure includes status and stderr", () => {
  const message = formatCommandFailure({
    stdout: "",
    stderr: "file not found",
    status: 1
  });
  assert.match(message, /status 1/);
  assert.match(message, /file not found/);
});

test("binaryAvailable returns true for node", () => {
  assert.equal(binaryAvailable("node"), true);
});

test("binaryAvailable returns false for nonexistent binary", () => {
  assert.equal(binaryAvailable("definitely-not-a-real-binary-xyz"), false);
});

test("spawnDetached returns a child process", () => {
  const child = spawnDetached("node", ["-e", "setTimeout(() => {}, 100)"]);
  assert.ok(child.pid > 0);
});

test("spawnDetached redirects stderr to logFile when provided", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-plugin-test-"));
  const logFile = path.join(dir, "log.txt");

  try {
    const child = spawnDetached("node", ["-e", 'process.stderr.write("hello-stderr")'], { logFile });
    child.ref();

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child did not exit in time")), 5000);
      child.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    const content = fs.readFileSync(logFile, "utf8");
    assert.equal(content, "hello-stderr");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnDetached without logFile returns a running child process", () => {
  const child = spawnDetached("node", ["-e", "process.exit(0)"]);
  assert.ok(child.pid > 0);
});

// --- cmd.exe command-injection regression (Windows .cmd/.bat wrap) ----------

test("cmdEscapeArg always quotes and keeps metacharacters literal", () => {
  assert.equal(cmdEscapeArg("abc"), '"abc"');
  assert.equal(cmdEscapeArg("a&b"), '"a&b"');     // & stays inside the quoted span
  assert.equal(cmdEscapeArg(""), '""');           // empty string survives
  assert.equal(cmdEscapeArg("%X%"), '""^%"X"^%""'); // %VAR% defused
});

test("runCommand on a .cmd shim does not let argv metacharacters chain a command", { skip: !IS_WINDOWS }, () => {
  withCmdShim(({ dir, call }) => {
    const marker = path.join(dir, "PWNED");
    const payload = 'review & echo x> "' + marker + '"';
    const r = call(["-p", payload, "--flag"]);
    // The chained `& echo > file` must never run.
    assert.equal(fs.existsSync(marker), false);
    // The argument is delivered to the target program verbatim, not split on &.
    assert.deepEqual(r.argv, ["-p", payload, "--flag"]);
  });
});

test("runCommand on a .cmd shim preserves pipes/redirs/percent/spaces verbatim", { skip: !IS_WINDOWS }, () => {
  withCmdShim(({ call }) => {
    const tricky = ["a | b > c < d ( e )", "has %PATH% literal", "a b", "", "c\\d", "tail\\"];
    const r = call(tricky);
    assert.deepEqual(r.argv, tricky);
  });
});

test("runCommand on a .cmd shim fails closed (no execution) on embedded-quote breakout", { skip: !IS_WINDOWS }, () => {
  withCmdShim(({ dir, call }) => {
    const marker = path.join(dir, "PWNED2");
    // Embedded quote + metachar: cmd may fail to invoke, but must never execute
    // the chained command.
    call(["-p", 'a"b & echo x> "' + marker + '"']);
    assert.equal(fs.existsSync(marker), false);
  });
});
