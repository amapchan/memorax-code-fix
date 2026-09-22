import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { invokeMemoryProvider } from "../../../dist/provider/adapter-dispatch.js";

function testScope() {
  return { schemaVersion: "workspace-memory-scope.v1", baseUserId: "u1",
    effectiveUserId: "u1@r", repositoryKey: "r", repositorySlug: "r",
    repositoryName: "r", identitySource: "origin-remote", scopeKind: "git-repository",
    boundWorkspaceRoot: "/t" };
}

test("dispatch routes to local provider by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memorax-dispatch-"));
  try {
    const result = await invokeMemoryProvider(
      { sessionId: "s1", prompt: "test query" },
      { provider_id: "memory.memorax", slot: "state_context", operation: "retrieve", query: "test" },
      { env: { MEMORAX_CODE_HOME: dir }, repositoryScope: testScope() },
    );
    assert.ok(result.ok, `expected local dispatch to succeed, got: ${result.ok ? "" : result.error}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dispatch routes to memorax when env override set", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memorax-dispatch-mx-"));
  try {
    const result = await invokeMemoryProvider(
      { sessionId: "s1", prompt: "test query" },
      { provider_id: "memory.memorax", slot: "state_context", operation: "retrieve", query: "test" },
      { env: { MEMORAX_CODE_HOME: dir, MEMORAX_CODE_MEMORY_PROVIDER: "memorax" }, repositoryScope: testScope() },
    );
    assert.equal(result.ok, false, "memorax should fail without API key");
    assert.ok(result.error.includes("API_KEY"), `expected API key error, got: ${result.error}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
