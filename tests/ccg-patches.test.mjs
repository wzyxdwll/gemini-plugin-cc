/**
 * Integration coverage for CCG patches P-15 / P-17 / P-20 / W1.
 *
 * Pre-CCG, the test suite covered only line-buffer overflow handling and
 * the broker/diagnostic trust boundary. This file fills the highest-value
 * gaps codex review flagged as I2.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { __testing as brokerTesting } from "../plugins/gemini/scripts/acp-broker.mjs";

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.written = [];
  }
  write(chunk) {
    this.written.push(String(chunk));
    return true;
  }
  end() {
    this.destroyed = true;
  }
  setEncoding() {}
}

class FakeAcpProcess extends EventEmitter {
  constructor() {
    super();
    this.stdin = {
      written: [],
      write: (chunk) => {
        this.stdin.written.push(String(chunk));
        return true;
      }
    };
  }
}

function parsePopped(socket) {
  return socket.written.map((line) => JSON.parse(line.trim()));
}

test("P-17 session/cancel bypasses BROKER_BUSY when another client holds activeClient", () => {
  brokerTesting.resetBrokerState();
  const acp = new FakeAcpProcess();
  brokerTesting.setAcpProcessMock(acp);
  brokerTesting.setAcpReady(true);

  // Simulate an active session held by socketA.
  const socketA = new FakeSocket();
  brokerTesting.setActiveClient(socketA);
  brokerTesting.setActiveSessionId("session-A");

  // socketB sends session/cancel — must be forwarded to ACP, NOT rejected
  // with BROKER_BUSY (regression for the pre-P-17 behavior).
  const socketB = new FakeSocket();
  const cancelMessage = JSON.stringify({
    jsonrpc: "2.0",
    id: 42,
    method: "session/cancel",
    params: { sessionId: "session-A" }
  });

  brokerTesting.handleClientMessage(socketB, cancelMessage);

  // Verify NO BROKER_BUSY error sent to socketB.
  const bResponses = parsePopped(socketB);
  for (const msg of bResponses) {
    if (msg.error) {
      assert.notEqual(
        msg.error.code,
        -32001,
        `Cancel should not be rejected with BROKER_BUSY; got ${JSON.stringify(msg.error)}`,
      );
    }
  }

  // Verify the cancel was forwarded to ACP.
  const acpForwarded = acp.stdin.written.map((s) => JSON.parse(s.trim()));
  const forwardedCancel = acpForwarded.find((m) => m.method === "session/cancel");
  assert.ok(forwardedCancel, "session/cancel should be forwarded to the ACP child");
  assert.equal(forwardedCancel.params.sessionId, "session-A");

  // Verify activeClient was NOT reassigned to socketB (notification routing
  // must continue going to socketA).
  assert.equal(
    brokerTesting.getActiveClient(),
    socketA,
    "interrupt passthrough must NOT hijack activeClient — notifications would misroute",
  );
});

test("P-17 non-cancel requests from a second client are still rejected with BROKER_BUSY", () => {
  brokerTesting.resetBrokerState();
  brokerTesting.setAcpProcessMock(new FakeAcpProcess());
  brokerTesting.setAcpReady(true);

  const socketA = new FakeSocket();
  brokerTesting.setActiveClient(socketA);

  const socketB = new FakeSocket();
  const promptMessage = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "session/prompt",
    params: { sessionId: "session-A", prompt: "hi" }
  });
  brokerTesting.handleClientMessage(socketB, promptMessage);

  const bResponses = parsePopped(socketB);
  const busyError = bResponses.find((m) => m.error?.code === -32001);
  assert.ok(busyError, "non-cancel concurrent request must be rejected with BROKER_BUSY");
});

test("P-20 cleanupClientSocket sends session/cancel to ACP when active client drops mid-prompt", () => {
  brokerTesting.resetBrokerState();
  const acp = new FakeAcpProcess();
  brokerTesting.setAcpProcessMock(acp);
  brokerTesting.setAcpReady(true);

  const socketA = new FakeSocket();
  brokerTesting.setActiveClient(socketA);
  brokerTesting.setActiveSessionId("session-A");
  // Inject a pending session/prompt for socketA.
  brokerTesting.pendingRequests.set(7, {
    clientSocket: socketA,
    clientId: 1,
    method: "session/prompt",
    sessionId: "session-A"
  });

  // Simulate the client disconnecting.
  brokerTesting.cleanupClientSocket(socketA);

  const acpForwarded = acp.stdin.written.map((s) => JSON.parse(s.trim()));
  const cancelSent = acpForwarded.find((m) => m.method === "session/cancel");
  assert.ok(cancelSent, "broker must tell ACP to abandon the orphaned stream");
  assert.equal(cancelSent.params.sessionId, "session-A");

  // pendingRequests for that socket must be cleared.
  assert.equal(brokerTesting.pendingRequests.size, 0);
  // activeClient must be released.
  assert.equal(brokerTesting.getActiveClient(), null);
  // activeSessionId must be reset (CCG-added correction to codex's draft).
  assert.equal(brokerTesting.getActiveSessionId(), null);
});

test("P-20 cleanupClientSocket is idempotent across error + close events", () => {
  brokerTesting.resetBrokerState();
  brokerTesting.setAcpProcessMock(new FakeAcpProcess());
  brokerTesting.setAcpReady(true);

  const socketA = new FakeSocket();
  brokerTesting.setActiveClient(socketA);
  brokerTesting.pendingRequests.set(1, {
    clientSocket: socketA,
    clientId: 1,
    method: "session/prompt",
    sessionId: "session-A"
  });

  // Both error and close commonly fire — must not throw or duplicate work.
  brokerTesting.cleanupClientSocket(socketA);
  brokerTesting.cleanupClientSocket(socketA);

  assert.equal(brokerTesting.pendingRequests.size, 0);
  assert.equal(brokerTesting.getActiveClient(), null);
});

test("P-20 normal prompt completion resets activeSessionId (correction over codex draft)", () => {
  brokerTesting.resetBrokerState();
  const acp = new FakeAcpProcess();
  brokerTesting.setAcpProcessMock(acp);
  brokerTesting.setAcpReady(true);

  const socketA = new FakeSocket();
  brokerTesting.setActiveClient(socketA);
  brokerTesting.setActiveSessionId("session-A");
  brokerTesting.pendingRequests.set(99, {
    clientSocket: socketA,
    clientId: 1,
    method: "session/prompt",
    sessionId: "session-A"
  });

  // ACP returns a successful prompt response — handleAcpLine should
  // release activeClient AND reset activeSessionId so the next cleanup
  // does not target a stale session id (which would cancel an unrelated
  // session on the next prompt run).
  brokerTesting.handleAcpLine(
    JSON.stringify({ jsonrpc: "2.0", id: 99, result: { ok: true } }),
  );

  assert.equal(brokerTesting.getActiveClient(), null);
  assert.equal(
    brokerTesting.getActiveSessionId(),
    null,
    "stale activeSessionId would cause spurious cancels on the next session",
  );
});

test("W1 interruptAcpPrompt returns attempted=false when no broker session exists", async () => {
  // Verify the fix: no broker on disk → must NOT spawn a fallback ACP child.
  // Pre-fix would have happily spawned + cancelled a fresh empty session.
  const { interruptAcpPrompt } = await import("../plugins/gemini/scripts/lib/gemini.mjs");

  const cwd = mkdtempSync(join(tmpdir(), "ccg-w1-"));
  try {
    const result = await interruptAcpPrompt(cwd, { sessionId: "anything" });
    assert.deepEqual(result, { attempted: false, interrupted: false });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
