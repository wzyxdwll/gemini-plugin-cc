/**
 * Broker process lifecycle management — spawning, health-checking, and tearing
 * down the persistent ACP broker process.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { resolveStateDir } from "./state.mjs";

export const PID_FILE_ENV = "GEMINI_COMPANION_ACP_PID_FILE";
export const LOG_FILE_ENV = "GEMINI_COMPANION_ACP_LOG_FILE";

const BROKER_SCRIPT = path.resolve(
  fileURLToPath(new URL("../acp-broker.mjs", import.meta.url))
);

const SESSION_DIR_NAME = "acp-session";

/**
 * Wait for a broker endpoint to accept connections.
 *
 * @param {string} endpoint
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function waitForBrokerEndpoint(endpoint, timeoutMs) {
  return new Promise((resolve) => {
    const target = parseBrokerEndpoint(endpoint);
    const deadline = Date.now() + timeoutMs;

    function attempt() {
      if (Date.now() > deadline) {
        resolve(false);
        return;
      }

      const socket = net.createConnection({ path: target.path });
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => {
        socket.destroy();
        setTimeout(attempt, 100);
      });
    }

    attempt();
  });
}

/**
 * CCG P-21: probe broker/ready RPC to verify the ACP child has actually
 * completed its initialize handshake. waitForBrokerEndpoint only verifies
 * that the socket is accepting connections, which happens before broker→ACP
 * initialize finishes — a client connecting at that point would hit "ACP
 * process is not ready" or queue (P-10).
 *
 * @param {string} endpoint
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function waitForBrokerReady(endpoint, timeoutMs) {
  return new Promise((resolve) => {
    const target = parseBrokerEndpoint(endpoint);
    const deadline = Date.now() + timeoutMs;

    function probe() {
      if (Date.now() > deadline) {
        resolve(false);
        return;
      }

      const socket = net.createConnection({ path: target.path });
      let buffer = "";
      const timer = setTimeout(() => {
        socket.destroy();
        setTimeout(probe, 100);
      }, 500);

      socket.on("connect", () => {
        socket.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "broker/ready", params: {} })}\n`,
        );
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newlineIdx = buffer.indexOf("\n");
        if (newlineIdx === -1) return;
        clearTimeout(timer);
        const line = buffer.slice(0, newlineIdx);
        socket.end();
        try {
          const response = JSON.parse(line);
          if (response?.result?.ready === true) {
            resolve(true);
            return;
          }
        } catch {
          // fall through to retry
        }
        setTimeout(probe, 100);
      });
      socket.on("error", () => {
        clearTimeout(timer);
        socket.destroy();
        setTimeout(probe, 100);
      });
    }

    probe();
  });
}

function resolveSessionDir(cwd) {
  return path.join(resolveStateDir(cwd), SESSION_DIR_NAME);
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), "broker-session.json");
}

/**
 * Load the persisted broker session info, if available.
 *
 * @param {string} cwd
 * @returns {{ endpoint: string, pidFile: string, logFile: string, sessionDir: string, pid: number | null } | null}
 */
export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

function saveBrokerSession(cwd, session) {
  const dir = resolveStateDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolveBrokerStateFile(cwd), JSON.stringify(session, null, 2), "utf8");
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

export async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

/**
 * Ensure a broker process is running for the given workspace. Starts one if needed.
 *
 * @param {string} cwd
 * @param {{ env?: NodeJS.ProcessEnv, killProcess?: (pid: number) => void, timeoutMs?: number }} [options]
 * @returns {Promise<{ endpoint: string, pidFile: string, logFile: string, sessionDir: string, pid: number | null } | null>}
 */
// CCG W2: per-workspace broker startup lock. Without this, two companion CLIs
// starting concurrently both observe `existing` is null/dead, both proceed to
// teardown + spawn, and end up with two broker daemons listening on the same
// endpoint (or, on POSIX, racing on unlink + listen of the same socket
// file). The lock serializes the check-spawn-publish sequence so only the
// first caller spawns; subsequent callers acquire the lock after broker is
// up and find `existing` valid on re-load.
//
// Stale-lock policy: a lock file older than LOCK_STALE_MS is treated as
// abandoned (the holder probably crashed before releasing) and forcibly
// unlinked. 30 s is generous vs the ~5 s spawn budget.
const LOCK_FILE_NAME = "broker.lock";
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 50;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireBrokerLock(sessionDir, timeoutMs = 8000) {
  const lockPath = path.join(sessionDir, LOCK_FILE_NAME);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeSync(fd, String(process.pid));
      } finally {
        fs.closeSync(fd);
      }
      return lockPath;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          // Holder likely crashed — reclaim.
          try { fs.unlinkSync(lockPath); } catch { /* race with another reaper */ }
          continue;
        }
      } catch {
        // lockPath disappeared between EEXIST and stat — retry.
        continue;
      }
      await sleep(LOCK_POLL_MS);
    }
  }
  throw new Error(`Could not acquire broker lock at ${lockPath} within ${timeoutMs}ms`);
}

function releaseBrokerLock(lockPath) {
  if (!lockPath) return;
  try { fs.unlinkSync(lockPath); } catch { /* already removed */ }
}

export async function ensureBrokerSession(cwd, options = {}) {
  const existing = loadBrokerSession(cwd);
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    return existing;
  }

  const sessionDir = resolveSessionDir(cwd);
  fs.mkdirSync(sessionDir, { recursive: true });

  // CCG W2: serialize broker startup. Re-check `existing` after acquiring
  // the lock — another concurrent caller may have just spawned the broker
  // while we were waiting.
  const lockPath = await acquireBrokerLock(sessionDir);
  try {
    const recheck = loadBrokerSession(cwd);
    if (recheck && (await isBrokerEndpointReady(recheck.endpoint))) {
      return recheck;
    }

    return await spawnAndPublishBroker(cwd, sessionDir, options);
  } finally {
    releaseBrokerLock(lockPath);
  }
}

async function spawnAndPublishBroker(cwd, sessionDir, options) {
  const existing = loadBrokerSession(cwd);
  if (existing) {
    teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: existing.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    clearBrokerSession(cwd);
  }

  const endpoint = createBrokerEndpoint(sessionDir);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");

  // CCG I1: route broker stdout/stderr into broker.log so daemon crashes,
  // initialize failures, and idle-timer / cancel diagnostics are recoverable
  // post-mortem. Previously stdio was ["ignore","ignore","ignore"] and the
  // LOG_FILE_ENV path was advertised but never written. fd is duplicated
  // into the detached child on spawn — we can (and must) close our handle
  // immediately so the parent process doesn't keep the file open.
  const logFd = fs.openSync(logFile, "a", 0o600);
  let child;
  try {
    child = spawn("node", [
      BROKER_SCRIPT,
      "serve",
      "--endpoint", endpoint,
      "--cwd", cwd,
      "--pid-file", pidFile
    ], {
      cwd,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...options.env ?? process.env,
        [PID_FILE_ENV]: pidFile,
        [LOG_FILE_ENV]: logFile
      }
    });
  } finally {
    fs.closeSync(logFd);
  }

  child.unref();

  // CCG P-21: use waitForBrokerReady (broker/ready RPC probe) instead of
  // just checking that the socket is accepting connections. This ensures
  // the ACP child has finished initialize before we tell the caller the
  // broker is usable.
  const ready = await waitForBrokerReady(endpoint, options.timeoutMs ?? 5000);
  if (!ready) {
    // CCG: preserve broker.log + sessionDir on spawn failure so the user
    // can diagnose why broker→ACP initialize never completed (auth, network,
    // gemini CLI bug, etc.). The pid is still killed and the endpoint
    // unlinked — only the diagnostic artifacts survive.
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      killProcess: options.killProcess ?? null,
      preserveLog: true
    });
    return null;
  }

  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null
  };
  saveBrokerSession(cwd, session);
  return session;
}

/**
 * Tear down a broker session, killing the process and cleaning up files.
 *
 * @param {{ endpoint?: string | null, pidFile?: string | null, logFile?: string | null, sessionDir?: string | null, pid?: number | null, killProcess?: ((pid: number) => void) | null }} params
 */
export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null, preserveLog = false }) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  // CCG: preserveLog allows callers (notably spawn-failure paths) to keep
  // broker.log around so a post-mortem can find why startup didn't complete.
  // Without this, every failed waitForBrokerReady tear-down deletes the
  // exact file needed to diagnose what happened — turning every transient
  // ACP hang into a silent reboot loop.
  if (!preserveLog && logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore cleanup failures.
    }
  }

  // Session dir removal also skipped when preserving log, since the log
  // lives inside the session dir.
  if (!preserveLog && sessionDir) {
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures.
    }
  }
}

/**
 * Send a broker/shutdown message to a running broker.
 *
 * @param {string} endpoint
 * @returns {Promise<boolean>}
 */
export async function sendBrokerShutdown(endpoint) {
  if (!endpoint) {
    return false;
  }

  return new Promise((resolve) => {
    try {
      const target = parseBrokerEndpoint(endpoint);
      const socket = net.createConnection({ path: target.path });
      const message = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "broker/shutdown",
        params: {}
      });

      socket.on("connect", () => {
        socket.write(`${message}\n`);
        // Give the broker time to process before closing.
        setTimeout(() => {
          socket.end();
          resolve(true);
        }, 200);
      });

      socket.on("error", () => {
        socket.destroy();
        resolve(false);
      });

      // Timeout the entire operation.
      setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 2000);
    } catch {
      resolve(false);
    }
  });
}
