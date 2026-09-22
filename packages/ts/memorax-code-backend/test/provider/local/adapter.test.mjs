import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { invokeLocalMemoryProvider } from "../../../dist/provider/local/adapter.js";

function testScope(baseUserId = "user-1", slug = "test-repo") {
  return {
    schemaVersion: "workspace-memory-scope.v1",
    baseUserId,
    effectiveUserId: `${baseUserId}@${slug}`,
    repositoryKey: `test-${slug}`,
    repositorySlug: slug,
    repositoryName: slug,
    identitySource: "origin-remote",
    scopeKind: "git-repository",
    boundWorkspaceRoot: "/test",
  };
}

function adapterOptions(home, scope) {
  return {
    env: { MEMORAX_CODE_HOME: home, ARKCODINGPLAN_API_KEY: "" },
    repositoryScope: scope,
  };
}

test("writeback stores content and retrieve finds it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memorax-adapter-"));
  try {
    const scope = testScope();
    const result = await invokeLocalMemoryProvider(
      { sessionId: "s1", prompt: "test" },
      {
        provider_id: "memory.local", slot: "state_context", operation: "writeback",
        context: {
          idempotencyKey: "test-wb-key-1",
          messages: [
            { role: "user", content: "How to use TypeScript?" },
            { role: "assistant", content: "TypeScript adds static types to JavaScript." },
          ],
        },
      },
      adapterOptions(dir, scope),
    );
    assert.ok(result.ok, `writeback failed: ${result.ok ? "" : result.error}`);
    const search = await invokeLocalMemoryProvider(
      { sessionId: "s1", prompt: "TypeScript" },
      { provider_id: "memory.local", slot: "state_context", operation: "retrieve", query: "TypeScript" },
      adapterOptions(dir, scope),
    );
    assert.ok(search.ok);
    const payload = search.result.tool_result_payload;
    assert.ok(payload.items.length > 0);
    assert.ok(payload.items[0].memory.includes("TypeScript"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("retrieve returns formatted context blocks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memorax-adapter-"));
  try {
    const scope = testScope();
    await invokeLocalMemoryProvider(
      { sessionId: "s1", prompt: "seed" },
      { provider_id: "memory.local", slot: "state_context", operation: "writeback",
        context: { idempotencyKey: "seed-key-1",
          messages: [{ role: "assistant", content: "React uses virtual DOM for rendering." }] } },
      adapterOptions(dir, scope),
    );
    const result = await invokeLocalMemoryProvider(
      { sessionId: "s1", prompt: "React" },
      { provider_id: "memory.local", slot: "state_context", operation: "retrieve", query: "React" },
      adapterOptions(dir, scope),
    );
    assert.ok(result.ok);
    const payload = result.result.tool_result_payload;
    assert.ok(payload.contextBlocks.length > 0);
    assert.ok(payload.contextBlocks[0].content.includes("<memories>"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("retrieve without repository scope fails closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memorax-adapter-"));
  try {
    const result = await invokeLocalMemoryProvider(
      { sessionId: "s1", prompt: "test" },
      { provider_id: "memory.local", slot: "state_context", operation: "retrieve", query: "test" },
      { env: { MEMORAX_CODE_HOME: dir } },
    );
    assert.equal(result.ok, false);
    assert.ok(result.error.includes("scope"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("duplicate idempotency key accepted without storing twice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memorax-adapter-"));
  try {
    const scope = testScope();
    const writeParams = {
      provider_id: "memory.local", slot: "state_context", operation: "writeback",
      context: { idempotencyKey: "dup-wb-1",
        messages: [{ role: "assistant", content: "Uses Docker for builds." }] },
    };
    const opts = adapterOptions(dir, scope);
    const first = await invokeLocalMemoryProvider({ sessionId: "s1", prompt: "x" }, writeParams, opts);
    assert.ok(first.ok);
    const dup = await invokeLocalMemoryProvider({ sessionId: "s1", prompt: "x" }, writeParams, opts);
    assert.ok(dup.ok, "duplicate should be accepted");
    const search = await invokeLocalMemoryProvider(
      { sessionId: "s1", prompt: "Docker" },
      { provider_id: "memory.local", slot: "state_context", operation: "retrieve", query: "Docker" },
      opts,
    );
    assert.ok(search.ok);
    assert.equal(search.result.tool_result_payload.items.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failing embed opens circuit: keyword fallback without re-probe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memorax-adapter-circuit-"));
  try {
    const scope = testScope();
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls += 1;
      return { ok: false, status: 500, json: async () => ({}) };
    };
    const circuitOpts = {
      env: { MEMORAX_CODE_HOME: dir, ARKCODINGPLAN_API_KEY: "stub-circuit-key" },
      repositoryScope: scope,
      fetchImpl,
    };
    await invokeLocalMemoryProvider(
      { sessionId: "s1", prompt: "seed" },
      { provider_id: "memory.local", slot: "state_context", operation: "writeback",
        context: { idempotencyKey: "circuit-wb-1",
          messages: [{ role: "assistant", content: "Uses Docker for builds." }] } },
      circuitOpts,
    );
    assert.equal(fetchCalls, 1, "writeback should probe exactly once");
    const first = await invokeLocalMemoryProvider(
      { sessionId: "s1", prompt: "Docker" },
      { provider_id: "memory.local", slot: "state_context", operation: "retrieve", query: "Docker" },
      circuitOpts,
    );
    assert.ok(first.ok);
    assert.ok(first.result.tool_result_payload.items.length > 0);
    assert.equal(fetchCalls, 1, "open circuit must not re-probe");
    const second = await invokeLocalMemoryProvider(
      { sessionId: "s1", prompt: "Docker" },
      { provider_id: "memory.local", slot: "state_context", operation: "retrieve", query: "Docker" },
      circuitOpts,
    );
    assert.ok(second.ok);
    assert.equal(fetchCalls, 1, "open circuit must not re-probe on later operations");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("emits observability events matching memorax shapes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memorax-adapter-obs-"));
  try {
    const scope = testScope();
    const events = [];
    const observability = { recordEvent: (event) => events.push(event) };
    const obsOpts = (source) => ({
      ...adapterOptions(dir, scope),
      observability,
      observabilitySource: source,
    });
    await invokeLocalMemoryProvider(
      { sessionId: "s1", prompt: "seed" },
      { provider_id: "memory.local", slot: "state_context", operation: "writeback",
        context: { idempotencyKey: "obs-wb-1",
          messages: [{ role: "assistant", content: "Uses Docker for builds." }] } },
      obsOpts("automatic_writeback"),
    );
    await invokeLocalMemoryProvider(
      { sessionId: "s1", prompt: "Docker" },
      { provider_id: "memory.local", slot: "state_context", operation: "retrieve", query: "Docker" },
      obsOpts("automatic_retrieval"),
    );
    assert.equal(events.length, 2);
    const [writeEvent, retrieveEvent] = events;
    assert.equal(writeEvent.source, "automatic_writeback");
    assert.equal(writeEvent.operation, "writeback");
    assert.equal(writeEvent.ok, true);
    assert.equal(writeEvent.request.slot, "state_context");
    assert.equal(writeEvent.request.idempotencyKey, "obs-wb-1");
    assert.equal(writeEvent.request.messageCount, 1);
    assert.ok(writeEvent.response.receiptId.startsWith("local:"));
    assert.equal(retrieveEvent.source, "automatic_retrieval");
    assert.equal(retrieveEvent.operation, "retrieve");
    assert.equal(retrieveEvent.ok, true);
    assert.equal(retrieveEvent.request.query, "Docker");
    assert.equal(retrieveEvent.response.itemCount, 1);
    assert.equal(retrieveEvent.response.contextBlockCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
