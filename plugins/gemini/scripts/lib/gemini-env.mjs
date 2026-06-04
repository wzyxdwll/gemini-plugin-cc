import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * Bridge ~/.gemini/.env auth keys into process.env.
 *
 * Why this exists:
 *   gemini-cli loads ~/.gemini/.env only when the spawn cwd is a *trusted*
 *   folder (security.folderTrust defaults to enabled). In an untrusted dir its
 *   findEnvFile() skips the ~/.gemini/.env branch entirely, so a user whose
 *   GEMINI_API_KEY lives there is reported as "not configured" even though the
 *   key is present. gemini-cli still honours real environment variables at the
 *   highest precedence regardless of trust, so we close the gap by hoisting the
 *   home-level auth keys into process.env before spawning gemini. The child
 *   then takes its env-var auth path and the trust gate no longer hides the key.
 *
 * Scope is deliberately narrow:
 *   - Only ~/.gemini/.env (home, user-owned — never an attacker-controlled
 *     project file). Project-level .env stays trust-gated, preserving the
 *     boundary folderTrust exists for.
 *   - Only the auth allowlist below (mirrors gemini-cli's own
 *     AUTH_ENV_VAR_WHITELIST), so we never leak unrelated vars.
 *   - Only when the key is absent/empty in the target, so an explicitly
 *     exported value always wins (matches gemini-cli's !Object.hasOwn order).
 *
 * Operational notes:
 *   - process.env (not just the child's env) is mutated so the auth fast-path in
 *     gemini.mjs and every downstream `env: process.env` spawn are fixed by one
 *     call. Any NEW process that launches the gemini binary must call this in its
 *     own entry point — there is no central spawn wrapper.
 *   - The broker daemon captures the bridge at spawn time; a reused broker won't
 *     pick up a ~/.gemini/.env created/edited after it started (restart to refresh).
 *   - Set GEMINI_COMPANION_NO_ENV_BRIDGE to a truthy value (e.g. 1/true) to
 *     disable the bridge entirely; empty, 0, and false are ignored.
 */

export const ENV_BRIDGE_DISABLE_VAR = "GEMINI_COMPANION_NO_ENV_BRIDGE";

// A disable flag should never be tripped by an explicit "off" value: a user who
// writes NO_ENV_BRIDGE=0 means "do not disable", so only a real truthy value
// counts. Keeps code behaviour aligned with the documented `=1` intent.
function isEnvFlagSet(value) {
  if (typeof value !== "string") return false;
  const v = value.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
}

export const GEMINI_AUTH_ENV_KEYS = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION"
];

function homeGeminiEnvPath() {
  return path.join(os.homedir(), ".gemini", ".env");
}

/**
 * Minimal KEY=VALUE parser. The plugin ships zero runtime deps, so we avoid the
 * `dotenv` package. Mirrors the dotenv subset that matters for auth keys:
 *   - blank / full-line `#` comment lines are skipped;
 *   - an optional `export` prefix (any whitespace, incl. tab) is stripped;
 *   - single/double quoted values are unwrapped, and any trailing text after the
 *     closing quote (e.g. `KEY="v" # note`) is ignored;
 *   - for an UNQUOTED value, an inline ` #` comment is stripped (a `#` with no
 *     leading whitespace stays part of the value, matching dotenv).
 * Multiline values and backslash-escaped quotes inside quoted values are
 * intentionally unsupported — the allowlisted auth keys are single-line and
 * only ever contain [A-Za-z0-9-_./], so neither can occur in practice.
 *
 * @param {string} content
 * @returns {Record<string, string>}
 */
export function parseDotenv(content) {
  const out = {};
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.replace(/^export\s+/, "");
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1);
      value = end >= 0 ? value.slice(1, end) : value.slice(1);
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash);
      value = value.trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Read the auth allowlist from a gemini .env file. Best-effort: returns {} on a
 * missing/unreadable file or parse failure — this is a convenience bridge, never
 * a hard dependency.
 *
 * @param {string} [filePath]
 * @returns {Record<string, string>}
 */
export function readHomeGeminiAuthEnv(filePath = homeGeminiEnvPath()) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return {};
  }
  const parsed = parseDotenv(content);
  const out = {};
  for (const key of GEMINI_AUTH_ENV_KEYS) {
    const value = parsed[key];
    if (typeof value === "string" && value !== "") out[key] = value;
  }
  return out;
}

/**
 * Hoist home auth keys into `target` (process.env by default), but only for keys
 * that are absent or empty there. Returns the list of keys actually applied.
 *
 * The allowlist is re-asserted here (not just in the reader) so the auth-only
 * guarantee is a property of this function regardless of what `source` a caller
 * passes — a hand-built source can never widen the hoisted set. Disabled
 * entirely when GEMINI_COMPANION_NO_ENV_BRIDGE is set.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string>} [target]
 * @param {Record<string, string>} [source]
 * @returns {string[]}
 */
export function applyHomeGeminiAuthEnv(target = process.env, source) {
  if (target == null) target = process.env;
  if (isEnvFlagSet(process.env[ENV_BRIDGE_DISABLE_VAR])) return [];
  const resolved = source ?? readHomeGeminiAuthEnv();
  const applied = [];
  for (const key of GEMINI_AUTH_ENV_KEYS) {
    const value = resolved[key];
    if (typeof value !== "string" || value === "") continue;
    const existing = target[key];
    if (existing === undefined || existing === "") {
      target[key] = value;
      applied.push(key);
    }
  }
  return applied;
}
