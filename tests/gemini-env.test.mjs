import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  GEMINI_AUTH_ENV_KEYS,
  ENV_BRIDGE_DISABLE_VAR,
  parseDotenv,
  readHomeGeminiAuthEnv,
  applyHomeGeminiAuthEnv
} from "../plugins/gemini/scripts/lib/gemini-env.mjs";

const SCRIPTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "gemini",
  "scripts"
);

test("parseDotenv: basic KEY=VALUE", () => {
  assert.deepEqual(parseDotenv("GEMINI_API_KEY=abc123"), { GEMINI_API_KEY: "abc123" });
});

test("parseDotenv: strips export prefix and surrounding quotes", () => {
  const parsed = parseDotenv([
    'export GEMINI_API_KEY="quoted value"',
    "GOOGLE_API_KEY='single'"
  ].join("\n"));
  assert.equal(parsed.GEMINI_API_KEY, "quoted value");
  assert.equal(parsed.GOOGLE_API_KEY, "single");
});

test("parseDotenv: ignores comments, blanks, and malformed lines", () => {
  const parsed = parseDotenv([
    "# a comment",
    "",
    "   ",
    "NOEQUALS",
    "=novalue",
    "1BAD=x",
    "GOOD=y"
  ].join("\n"));
  assert.deepEqual(parsed, { GOOD: "y" });
});

test("readHomeGeminiAuthEnv: returns only allowlist keys, skips empty values", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-env-"));
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, [
    "GEMINI_API_KEY=key1",
    "GOOGLE_CLOUD_PROJECT=proj",
    "GOOGLE_API_KEY=",
    "UNRELATED=should-not-leak"
  ].join("\n"));
  try {
    const out = readHomeGeminiAuthEnv(file);
    assert.deepEqual(out, { GEMINI_API_KEY: "key1", GOOGLE_CLOUD_PROJECT: "proj" });
    assert.ok(!("UNRELATED" in out));
    assert.ok(!("GOOGLE_API_KEY" in out));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readHomeGeminiAuthEnv: missing file returns {}", () => {
  const missing = path.join(os.tmpdir(), "gemini-env-does-not-exist-xyz", ".env");
  assert.deepEqual(readHomeGeminiAuthEnv(missing), {});
});

test("applyHomeGeminiAuthEnv: sets absent keys", () => {
  const target = {};
  const applied = applyHomeGeminiAuthEnv(target, { GEMINI_API_KEY: "k" });
  assert.deepEqual(applied, ["GEMINI_API_KEY"]);
  assert.equal(target.GEMINI_API_KEY, "k");
});

test("applyHomeGeminiAuthEnv: does not clobber an existing value", () => {
  const target = { GEMINI_API_KEY: "existing" };
  const applied = applyHomeGeminiAuthEnv(target, { GEMINI_API_KEY: "fromfile" });
  assert.deepEqual(applied, []);
  assert.equal(target.GEMINI_API_KEY, "existing");
});

test("applyHomeGeminiAuthEnv: treats empty string as absent", () => {
  const target = { GEMINI_API_KEY: "" };
  const applied = applyHomeGeminiAuthEnv(target, { GEMINI_API_KEY: "fromfile" });
  assert.deepEqual(applied, ["GEMINI_API_KEY"]);
  assert.equal(target.GEMINI_API_KEY, "fromfile");
});

test("GEMINI_AUTH_ENV_KEYS mirrors gemini-cli auth allowlist", () => {
  assert.deepEqual(GEMINI_AUTH_ENV_KEYS, [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION"
  ]);
});

test("parseDotenv: strips an inline comment from an unquoted value", () => {
  assert.deepEqual(parseDotenv("GEMINI_API_KEY=key123 # prod"), { GEMINI_API_KEY: "key123" });
});

test("parseDotenv: keeps a '#' with no leading whitespace as part of the value", () => {
  assert.deepEqual(parseDotenv("GEMINI_API_KEY=a#b"), { GEMINI_API_KEY: "a#b" });
});

test("parseDotenv: preserves '#' inside a quoted value", () => {
  assert.deepEqual(parseDotenv('GEMINI_API_KEY="a#b"'), { GEMINI_API_KEY: "a#b" });
});

test("parseDotenv: ignores trailing text after a closing quote", () => {
  assert.deepEqual(parseDotenv('GEMINI_API_KEY="val" # prod'), { GEMINI_API_KEY: "val" });
});

test("parseDotenv: strips an export prefix with a tab or extra spaces", () => {
  assert.equal(parseDotenv("export\tGEMINI_API_KEY=x").GEMINI_API_KEY, "x");
  assert.equal(parseDotenv("export   GOOGLE_API_KEY=y").GOOGLE_API_KEY, "y");
});

test("applyHomeGeminiAuthEnv: re-asserts the allowlist even for a hand-built source", () => {
  const target = {};
  const applied = applyHomeGeminiAuthEnv(target, { EVIL: "x", GEMINI_API_KEY: "k" });
  assert.deepEqual(applied, ["GEMINI_API_KEY"]);
  assert.equal(target.GEMINI_API_KEY, "k");
  assert.ok(!("EVIL" in target));
});

test("applyHomeGeminiAuthEnv: does nothing when the disable var is set", () => {
  const prev = process.env[ENV_BRIDGE_DISABLE_VAR];
  process.env[ENV_BRIDGE_DISABLE_VAR] = "1";
  try {
    const target = {};
    const applied = applyHomeGeminiAuthEnv(target, { GEMINI_API_KEY: "k" });
    assert.deepEqual(applied, []);
    assert.ok(!("GEMINI_API_KEY" in target));
  } finally {
    if (prev === undefined) delete process.env[ENV_BRIDGE_DISABLE_VAR];
    else process.env[ENV_BRIDGE_DISABLE_VAR] = prev;
  }
});

test("applyHomeGeminiAuthEnv: an explicit off value (0/false) does NOT disable the bridge", () => {
  const prev = process.env[ENV_BRIDGE_DISABLE_VAR];
  try {
    for (const off of ["0", "false", "", "  "]) {
      process.env[ENV_BRIDGE_DISABLE_VAR] = off;
      const target = {};
      const applied = applyHomeGeminiAuthEnv(target, { GEMINI_API_KEY: "k" });
      assert.deepEqual(applied, ["GEMINI_API_KEY"], `value ${JSON.stringify(off)} must not disable`);
      assert.equal(target.GEMINI_API_KEY, "k");
    }
  } finally {
    if (prev === undefined) delete process.env[ENV_BRIDGE_DISABLE_VAR];
    else process.env[ENV_BRIDGE_DISABLE_VAR] = prev;
  }
});

test("applyHomeGeminiAuthEnv: null target does not throw (no-op for empty source)", () => {
  assert.doesNotThrow(() => {
    const applied = applyHomeGeminiAuthEnv(null, { GEMINI_API_KEY: "" });
    assert.deepEqual(applied, []);
  });
});

test("every gemini-binary entry point wires in applyHomeGeminiAuthEnv()", () => {
  const entries = [
    "gemini-companion.mjs",
    "gemini-batch.mjs",
    "acp-broker.mjs",
    "stop-review-gate-hook.mjs"
  ];
  for (const entry of entries) {
    const src = fs.readFileSync(path.join(SCRIPTS_DIR, entry), "utf-8");
    assert.match(src, /import \{ applyHomeGeminiAuthEnv \} from "\.\/lib\/gemini-env\.mjs"/,
      `${entry} must import applyHomeGeminiAuthEnv`);
    assert.match(src, /applyHomeGeminiAuthEnv\(\)/,
      `${entry} must call applyHomeGeminiAuthEnv() in its entry path`);
  }
});
