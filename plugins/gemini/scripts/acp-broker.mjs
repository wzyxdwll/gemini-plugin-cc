#!/usr/bin/env node

/**
 * Persistent ACP broker daemon. Listens on a Unix socket (Linux/macOS) or named
 * pipe (Windows), spawns a single `gemini --acp` child process, and multiplexes
 * JSON-RPC requests from multiple client connections.
 *
 * Usage:
 *   node scripts/acp-broker.mjs serve --endpoint <unix:/path|pipe:\\\\.\\pipe\\name> [--cwd <path>] [--pid-file <path>]
 *
 * Returns BROKER_BUSY_RPC_CODE (-32001) when another request is in flight.
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { parseArgs } from "./lib/args.mjs";
import { ACP_MAX_LINE_BUFFER, BROKER_BUSY_RPC_CODE } from "./lib/acp-client.mjs";
import {
  attachStderrDiagnosticCollector,
  BROKER_DIAGNOSTIC_METHOD,
  buildBrokerDiagnosticNotification,
  sanitizeDiagnosticMessage
} from "./lib/acp-diagnostics.mjs";
import { buildGeminiAcpArgs } from "./lib/acp-args.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import { listenOnRestrictedUnixSocket } from "./lib/socket-permissions.mjs";
import { spawn } from "node:child_process";
import readline from "node:readline";

const SHUTDOWN_GRACE_MS = 500;
const MAX_DIAGNOSTIC_RING = 25;

/**
 * Ring of pre-built, sanitized broker/diagnostic JSON-RPC notifications. We
 * build the notification (including source sanitization and message bounding)
 * at ingress time so the ring never holds raw-length messages. Replay just
 * writes the stored notification to the next client that takes the lock.
 */
const diagnosticRing = [];

function rememberDiagnostic(notification) {
  diagnosticRing.push(notification);
  if (diagnosticRing.length > MAX_DIAGNOSTIC_RING) {
    diagnosticRing.shift();
  }
}

function forwardDiagnosticToActiveClient(source, message) {
  const notification = buildBrokerDiagnosticNotification({ source, message });
  if (activeClient && !activeClient.destroyed) {
    send(activeClient, notification);
  } else {
    // Buffer for replay to the next client that takes the lock so pre-connect
    // diagnostics (auth errors, broker child startup warnings) are not lost.
    rememberDiagnostic(notification);
  }
}

function drainDiagnosticRingTo(socket) {
  if (diagnosticRing.length === 0 || !socket || socket.destroyed) {
    return;
  }
  for (const notification of diagnosticRing) {
    send(socket, notification);
  }
  diagnosticRing.length = 0;
}

// ─── Gemini ACP Child Process ─────────────────────────────────────────────────

let acpProcess = null;
let acpReady = false;
let nextRpcId = 1;

/**
 * @type {Map<number, { clientSocket: net.Socket | null, clientId: number | null, method?: string, sessionId?: string | null }>}
 */
const pendingRequests = new Map();

/** @type {net.Socket | null} */
let activeClient = null;

// CCG P-20: track the sessionId of the prompt currently being forwarded so
// that if the active client drops we can cancel the right ACP session.
/** @type {string | null} */
let activeSessionId = null;

// CCG P-14: broker idle watchdog. The broker daemon is detached + unref'd
// (broker-lifecycle.mjs spawn options) and has no self-shutdown — without
// this it lives until reboot or manual kill. Idle = no activeClient for
// IDLE_TIMEOUT_MS. Override via BROKER_IDLE_TIMEOUT_MS env. 0 disables.
function parseBrokerIdleTimeout() {
  const raw = process.env.BROKER_IDLE_TIMEOUT_MS;
  if (raw == null || raw === "") return 30 * 60 * 1000; // 30 min default
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 30 * 60 * 1000;
  return n;
}
const IDLE_TIMEOUT_MS = parseBrokerIdleTimeout();
let idleTimer = null;

function startIdleTimer() {
  if (IDLE_TIMEOUT_MS === 0) return;
  if (idleTimer != null) return;
  idleTimer = setTimeout(() => {
    process.stderr.write(
      `[acp-broker] idle for ${Math.round(IDLE_TIMEOUT_MS / 60000)} min — exiting.\n`,
    );
    shutdown();
  }, IDLE_TIMEOUT_MS);
  if (typeof idleTimer.unref === "function") idleTimer.unref();
}

function cancelIdleTimer() {
  if (idleTimer != null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function spawnAcpProcess(cwd) {
  const child = spawn("gemini", buildGeminiAcpArgs(process.env), {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
    shell: process.platform === "win32",
    windowsHide: true
  });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => handleAcpLine(line));

  if (child.stderr) {
    attachStderrDiagnosticCollector(child.stderr, (message) => {
      process.stderr.write(`[gemini --acp stderr] ${message}\n`);
      forwardDiagnosticToActiveClient("broker-child-stderr", message);
    });
  }

  child.on("exit", (code) => {
    const exitMessage = `gemini --acp exited with code ${code}`;
    process.stderr.write(`${exitMessage}\n`);
    forwardDiagnosticToActiveClient("broker-child-exit", exitMessage);
    acpProcess = null;
    acpReady = false;

    // Reject all pending requests.
    for (const [id, pending] of pendingRequests) {
      if (!pending.clientSocket) continue;
      send(pending.clientSocket, {
        jsonrpc: "2.0",
        id: pending.clientId,
        error: buildJsonRpcError(-32000, "ACP process exited unexpectedly.")
      });
    }
    pendingRequests.clear();
  });

  child.on("error", (error) => {
    const errorMessage = `gemini --acp error: ${error.message}`;
    process.stderr.write(`${errorMessage}\n`);
    forwardDiagnosticToActiveClient("broker-child-error", errorMessage);
    acpProcess = null;
    acpReady = false;
  });

  acpProcess = child;

  // Send initialize handshake.
  // CCG P-21: must include protocolVersion (ACP schema requires `number`).
  // gemini-cli ≥0.39 rejects initialize without it with -32603 "Internal
  // error" / "expected number, received undefined" — broker would then sit
  // forever with acpReady=false.
  // Register the pending entry BEFORE sendToAcp so a synchronous-fast response
  // can't arrive before we record where to route it.
  const initId = nextRpcId++;
  pendingRequests.set(initId, { clientSocket: null, clientId: null });
  sendToAcp({
    jsonrpc: "2.0",
    id: initId,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientInfo: {
        name: "gemini-plugin-cc-broker",
        version: "1.0.0"
      }
    }
  });

  return child;
}

function sendToAcp(message) {
  if (!acpProcess?.stdin) {
    return;
  }
  acpProcess.stdin.write(`${JSON.stringify(message)}\n`);
}

function handleAcpLine(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  // Handle response (has id).
  if ("id" in message && message.id !== null) {
    const pending = pendingRequests.get(message.id);
    if (pending) {
      pendingRequests.delete(message.id);

      if (pending.clientSocket === null) {
        // Initialize response.
        // CCG P-21: an error response must NOT mark broker as ready —
        // previously acpReady was set unconditionally, so a failed handshake
        // (auth, protocol mismatch, etc.) would leave the broker accepting
        // client requests against a dead ACP channel. On failure, log and
        // shut down so the next companion call respawns cleanly.
        if (message.error) {
          acpReady = false;
          const reason =
            message.error?.message ?? JSON.stringify(message.error);
          process.stderr.write(
            `ACP broker: gemini --acp initialize failed: ${reason}\n`,
          );
          shutdown();
          return;
        }
        acpReady = true;
        process.stderr.write("ACP broker: gemini --acp initialized.\n");
        return;
      }

      // Forward response to the client with their original id.
      send(pending.clientSocket, {
        jsonrpc: "2.0",
        id: pending.clientId,
        result: message.result,
        error: message.error
      });

      // If no more pending requests for this client, release the lock.
      const hasMore = [...pendingRequests.values()].some(
        (p) => p.clientSocket === pending.clientSocket
      );
      if (!hasMore && pending.clientSocket === activeClient) {
        activeClient = null;
        activeSessionId = null; // CCG P-20: don't leak stale sessionId
        startIdleTimer(); // CCG P-14: nothing active, start idle countdown
      }
    }
    return;
  }

  // Handle notification — forward to active client if any.
  if (message.method && activeClient && !activeClient.destroyed) {
    // Trust boundary: the broker is the sole legitimate emitter of
    // broker/diagnostic. A notification with this method on the child's
    // stdout is a forgery attempt (e.g. a compromised gemini --acp child
    // trying to phish the user via /gemini:status healthMessage). Drop it
    // instead of forwarding unchanged.
    if (message.method === BROKER_DIAGNOSTIC_METHOD) {
      process.stderr.write(
        "[acp-broker] security: dropped child-originated broker/diagnostic notification.\n"
      );
      return;
    }
    send(activeClient, message);
  }
}

// ─── Client Connection Handling ───────────────────────────────────────────────

function handleClientConnection(socket) {
  let lineBuffer = "";

  socket.setEncoding("utf8");

  socket.on("data", (chunk) => {
    lineBuffer += chunk;
    let newlineIndex;
    while ((newlineIndex = lineBuffer.indexOf("\n")) !== -1) {
      const line = lineBuffer.slice(0, newlineIndex);
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      handleClientMessage(socket, line);
    }
    // Guard against a misbehaving client that streams data without newlines.
    // Mirrors AcpClientBase.handleChunk: truncate to the last
    // ACP_MAX_LINE_BUFFER bytes and emit a broker/diagnostic so operators can
    // see the drop.
    if (lineBuffer.length > ACP_MAX_LINE_BUFFER) {
      const dropped = lineBuffer.length - ACP_MAX_LINE_BUFFER;
      lineBuffer = lineBuffer.slice(-ACP_MAX_LINE_BUFFER);
      sendClientLineBufferOverflowDiagnostic(socket, dropped);
    }
  });

  socket.on("error", () => cleanupClientSocket(socket));
  socket.on("close", () => cleanupClientSocket(socket));
}

// CCG P-20: unified cleanup for client error / close events. Previously
// error and close handlers were asymmetric (error cleared pendingRequests
// but close did not), and neither told ACP to cancel the in-flight prompt
// — so a client timeout would leave session/update notifications routing
// to whoever next took activeClient and the eventual response with no
// home in pendingRequests. Idempotent: safe to call from both events.
function cleanupClientSocket(socket) {
  const owned = [...pendingRequests.values()].filter(
    (p) => p.clientSocket === socket,
  );
  // If this socket owned the active prompt, tell ACP to abandon it.
  // Without this the gemini --acp child keeps streaming tokens at us
  // until completion, wasting tokens and confusing routing.
  if (owned.length > 0 && activeClient === socket && acpProcess && acpReady) {
    const promptEntry = owned.find((p) => p.method === "session/prompt");
    const sessionId = promptEntry?.sessionId ?? activeSessionId;
    sendToAcp({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: sessionId ? { sessionId } : {},
    });
  }

  for (const [id, pending] of pendingRequests) {
    if (pending.clientSocket === socket) {
      pendingRequests.delete(id);
    }
  }

  if (activeClient === socket) {
    activeClient = null;
    activeSessionId = null;
    startIdleTimer(); // CCG P-14
  }
}

function handleClientMessage(socket, line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  // Handle broker/shutdown.
  if (message.method === "broker/shutdown") {
    send(socket, {
      jsonrpc: "2.0",
      id: message.id ?? null,
      result: { ok: true }
    });
    shutdown();
    return;
  }

  // CCG P-21: broker/ready probe — lets ensureBrokerSession in broker-lifecycle
  // distinguish "TCP socket is up" from "ACP child has finished initialize".
  // Without this, lifecycle returned as soon as listen() succeeded, but the
  // first client request could hit "ACP process is not ready" or fall into
  // pendingQueue while broker→ACP initialize was still in flight.
  if (message.method === "broker/ready") {
    send(socket, {
      jsonrpc: "2.0",
      id: message.id ?? null,
      result: { ready: Boolean(acpProcess && acpReady) }
    });
    return;
  }

  // Handle initialize — respond directly (broker handles handshake).
  if (message.method === "initialize") {
    send(socket, {
      jsonrpc: "2.0",
      id: message.id ?? null,
      result: {
        capabilities: {},
        serverInfo: {
          name: "gemini-plugin-cc-broker",
          version: "1.0.0"
        }
      }
    });
    return;
  }

  // CCG P-17: interrupt passthrough. session/cancel is the ACP-native cancel
  // method (acp-protocol.d.ts:218). Allow it to bypass the busy check so a
  // second client can cancel the active stream — mirrors codex broker's
  // turn/interrupt passthrough behavior. The cancel is forwarded to ACP; the
  // canceled request on the active client will reject via P-9 error wrap.
  const isInterruptMethod = message.method === "session/cancel";

  // Check if broker is busy.
  if (activeClient && activeClient !== socket && !isInterruptMethod) {
    send(socket, {
      jsonrpc: "2.0",
      id: message.id ?? null,
      error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Broker is busy with another request.")
    });
    return;
  }

  // Check if ACP process is ready.
  if (!acpProcess || !acpReady) {
    send(socket, {
      jsonrpc: "2.0",
      id: message.id ?? null,
      error: buildJsonRpcError(-32000, "ACP process is not ready.")
    });
    return;
  }

  // Forward request to ACP process.
  // CCG P-17: interrupt passthrough must NOT reassign activeClient — the
  // notification fan-out at line ~217 only delivers to activeClient, so
  // hijacking the lock would cause session/update notifications for the
  // ongoing prompt to be misrouted to the cancel originator. Response
  // routing happens via pendingRequests map (id-keyed), which works
  // regardless of activeClient.
  if (!isInterruptMethod) {
    const newlyActive = activeClient !== socket;
    activeClient = socket;
    if (newlyActive) {
      drainDiagnosticRingTo(socket);
    }
    cancelIdleTimer(); // CCG P-14: broker has work, cancel idle countdown
  }
  // CCG P-20: record the sessionId of the active prompt so that on abnormal
  // client disconnect we can issue session/cancel to ACP with the right id.
  // Interrupt RPCs (session/cancel) carry a sessionId too but must not
  // overwrite the active one — they target it, they don't become it.
  const params = message.params ?? {};
  const sessionIdFromParams =
    typeof params.sessionId === "string" && params.sessionId.length > 0
      ? params.sessionId
      : null;
  if (!isInterruptMethod && sessionIdFromParams) {
    activeSessionId = sessionIdFromParams;
  }

  const brokerId = nextRpcId++;
  pendingRequests.set(brokerId, {
    clientSocket: socket,
    clientId: message.id ?? null,
    method: message.method,
    sessionId: sessionIdFromParams,
  });

  sendToAcp({
    jsonrpc: "2.0",
    id: brokerId,
    method: message.method,
    params
  });
}

// ─── Server ───────────────────────────────────────────────────────────────────

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (!socket || socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function sendClientLineBufferOverflowDiagnostic(socket, dropped) {
  send(
    socket,
    buildBrokerDiagnosticNotification({
      source: "acp-transport",
      message: sanitizeDiagnosticMessage(
        `[client line buffer overflow: dropped ${dropped} bytes]`
      )
    })
  );
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pidFile, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
}

let server = null;

export const __testing = {
  handleClientConnection,
  handleClientMessage,
  handleAcpLine,
  cleanupClientSocket,
  pendingRequests,
  setActiveClient(socket) {
    activeClient = socket;
  },
  setActiveSessionId(id) {
    activeSessionId = id;
  },
  getActiveClient() {
    return activeClient;
  },
  getActiveSessionId() {
    return activeSessionId;
  },
  setAcpProcessMock(proc) {
    acpProcess = proc;
  },
  setAcpReady(ready) {
    acpReady = Boolean(ready);
  },
  resetBrokerState() {
    diagnosticRing.length = 0;
    pendingRequests.clear();
    activeClient = null;
    activeSessionId = null;
    acpProcess = null;
    acpReady = false;
    nextRpcId = 1;
    server = null;
  }
};

function shutdown() {
  process.stderr.write("ACP broker shutting down.\n");

  // Kill the ACP process.
  if (acpProcess) {
    try {
      acpProcess.kill("SIGTERM");
    } catch {
      // Ignore.
    }
  }

  // Close the server.
  if (server) {
    server.close();
  }

  setTimeout(() => {
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error(
      "Usage: node scripts/acp-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]"
    );
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  const target = parseBrokerEndpoint(options.endpoint);

  // CCG W2: clean up stale socket file, but only if no live broker is
  // listening on it. Without this check, a fresh broker starting up could
  // unlink the socket of another broker that is currently serving clients
  // (e.g. concurrent ensureBrokerSession race that slipped past the lock
  // due to clock skew or a stale lock reclaim).
  if (target.kind === "unix" && fs.existsSync(target.path)) {
    const inUse = await new Promise((resolve) => {
      const probe = net.createConnection({ path: target.path });
      const t = setTimeout(() => { probe.destroy(); resolve(false); }, 250);
      probe.on("connect", () => { clearTimeout(t); probe.end(); resolve(true); });
      probe.on("error", () => { clearTimeout(t); probe.destroy(); resolve(false); });
    });
    if (inUse) {
      process.stderr.write(
        `ACP broker: socket ${target.path} already serving a live broker — refusing to start.\n`,
      );
      process.exit(0);
    }
    fs.unlinkSync(target.path);
  }

  writePidFile(pidFile);

  // Spawn the Gemini ACP process.
  spawnAcpProcess(cwd);

  // Start listening.
  server = net.createServer(handleClientConnection);

  if (target.kind === "unix") {
    fs.mkdirSync(path.dirname(target.path), { recursive: true, mode: 0o700 });
    listenOnRestrictedUnixSocket(server, target.path, () => {
      process.stderr.write(`ACP broker listening on ${target.path}\n`);
    });
  } else {
    server.listen(target.path, () => {
      process.stderr.write(`ACP broker listening on ${target.path}\n`);
    });
  }

  // Handle signals.
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // CCG P-14: start idle watchdog. Broker just spawned with no active client,
  // so begin the idle countdown immediately. The timer is cleared as soon as
  // any client activity begins (handleClientMessage → cancelIdleTimer).
  startIdleTimer();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
