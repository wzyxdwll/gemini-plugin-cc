import test from "node:test";
import assert from "node:assert/strict";

import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/gemini/scripts/lib/broker-endpoint.mjs";

test("createBrokerEndpoint uses Unix sockets on non-Windows platforms", () => {
  const endpoint = createBrokerEndpoint("/tmp/cxc-12345", "darwin");
  assert.equal(endpoint, "unix:/tmp/cxc-12345/broker.sock");
  assert.deepEqual(parseBrokerEndpoint(endpoint), {
    kind: "unix",
    path: "/tmp/cxc-12345/broker.sock"
  });
});

test("createBrokerEndpoint uses named pipes on Windows", () => {
  // CCG P-19: pipe name derives from sessionDir's parent dir basename
  // (the per-workspace "<slug>-<hash>" state dir), not sessionDir's own
  // basename (which is the constant "acp-session" and would collide
  // across all workspaces).
  const endpoint = createBrokerEndpoint("C:\\Temp\\cxc-12345\\acp-session", "win32");
  assert.equal(endpoint, "pipe:\\\\.\\pipe\\cxc-12345-gemini-acp");
  assert.deepEqual(parseBrokerEndpoint(endpoint), {
    kind: "pipe",
    path: "\\\\.\\pipe\\cxc-12345-gemini-acp"
  });
});

test("createBrokerEndpoint produces distinct pipe names per workspace on Windows", () => {
  // Regression guard for the pre-P-19 collision bug.
  const endpointA = createBrokerEndpoint("C:\\state\\foo-abc123\\acp-session", "win32");
  const endpointB = createBrokerEndpoint("C:\\state\\bar-def456\\acp-session", "win32");
  assert.notEqual(endpointA, endpointB, "different workspaces must get different pipes");
  assert.equal(endpointA, "pipe:\\\\.\\pipe\\foo-abc123-gemini-acp");
  assert.equal(endpointB, "pipe:\\\\.\\pipe\\bar-def456-gemini-acp");
});
