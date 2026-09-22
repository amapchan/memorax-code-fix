import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalMemoryStore } from "../../../dist/provider/local/store.js";

function testScope() {
  return {
    baseUserId: "user-1",
    effectiveUserId: "user-1@test-repo",
    repositorySlug: "test-repo",
  };
}

function scopedScope(slug) {
  return {
    baseUserId: "user-1",
    effectiveUserId: "user-1@scope-test",
    repositorySlug: slug,
  };
}

test("insertMemory stores and retrieves a memory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memorax-store-"));
  try {
    const store = new LocalMemoryStore(join(dir, "test.db"));
    const scope = testScope();
    const id = store.insertMemory({
      scope,
      content: "Uses TypeScript strict mode",
      memoryType: "semantic",
      idempotencyKey: "test-key-1",
      sessionId: "session-1",
      embedding: null,
      embeddingDimensions: null,
      embeddingModel: null,
    });
    assert.ok(id);
    const results = store.searchByKeyword({ scope, query: "TypeScript", topK: 5 });
    assert.equal(results.length, 1);
    assert.equal(results[0].content, "Uses TypeScript strict mode");
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("idempotency key prevents duplicate insert", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memorax-store-"));
  try {
    const store = new LocalMemoryStore(join(dir, "test.db"));
    const scope = testScope();
    const params = {
      scope, content: "test content", memoryType: "semantic",
      idempotencyKey: "dup-key", sessionId: "s1",
      embedding: null, embeddingDimensions: null, embeddingModel: null,
    };
    store.insertMemory(params);
    assert.throws(() => store.insertMemory(params), /UNIQUE constraint/);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("searchByVector returns nearest memories by cosine similarity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memorax-store-"));
  try {
    const store = new LocalMemoryStore(join(dir, "test.db"));
    const scope = testScope();
    const v1 = new Float32Array([1, 0, 0]);
    const v2 = new Float32Array([0, 1, 0]);
    store.insertMemory({ scope, content: "aligned", memoryType: "semantic",
      idempotencyKey: "k1", sessionId: "s1",
      embedding: Buffer.from(v1.buffer), embeddingDimensions: 3, embeddingModel: "test" });
    store.insertMemory({ scope, content: "orthogonal", memoryType: "semantic",
      idempotencyKey: "k2", sessionId: "s1",
      embedding: Buffer.from(v2.buffer), embeddingDimensions: 3, embeddingModel: "test" });
    const results = store.searchByVector({ scope, queryVector: v1, topK: 2, minScore: 0 });
    assert.equal(results.length, 2);
    assert.equal(results[0].content, "aligned");
    assert.ok(results[0].score > 0.99);
    assert.ok(results[1].score < 0.01);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("opens database with WAL journal mode and busy timeout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memorax-store-"));
  try {
    const store = new LocalMemoryStore(join(dir, "test.db"));
    assert.equal(store.db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(store.db.prepare("PRAGMA busy_timeout").get().timeout, 2000);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("embedding BLOB written from a pooled buffer view round-trips exactly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memorax-store-"));
  try {
    const store = new LocalMemoryStore(join(dir, "test.db"));
    const scope = testScope();
    const pooled = new Float32Array([1, 0, 0, 9, 9, 9]);
    const view = new Float32Array(pooled.buffer, 0, 3);
    store.insertMemory({
      scope,
      content: "pooled view",
      memoryType: "semantic",
      idempotencyKey: "pool-key-1",
      sessionId: "s1",
      embedding: Buffer.from(view.buffer, view.byteOffset, view.byteLength),
      embeddingDimensions: 3,
      embeddingModel: "test",
    });
    const results = store.searchByVector({
      scope,
      queryVector: new Float32Array([1, 0, 0]),
      topK: 2,
      minScore: 0,
    });
    assert.equal(results.length, 1);
    assert.ok(results[0].score > 0.99, `expected aligned score, got ${results[0].score}`);
    assert.equal(results[0].embeddingDimensions, 3);
    assert.equal(results[0].embedding.length, 12, "BLOB must contain only the vector bytes");
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migrates an old-shape database by backfilling the FTS index", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memorax-store-"));
  let store;
  try {
    const dbPath = join(dir, "legacy.db");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, repository_slug TEXT,
        content TEXT NOT NULL, memory_type TEXT NOT NULL DEFAULT 'semantic',
        embedding BLOB, embedding_dimensions INTEGER, embedding_model TEXT,
        session_id TEXT, idempotency_key TEXT UNIQUE, metadata TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    legacy.prepare(`
      INSERT INTO memories (id, user_id, repository_slug, content, memory_type,
        embedding, embedding_dimensions, embedding_model, session_id,
        idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("legacy-1", "user-1@test-repo", "test-repo",
      "fstab 挂载配置修复流程", "semantic", null, null, null, null, "legacy-key-1", 1, 1);
    legacy.close();

    store = new LocalMemoryStore(dbPath);
    const results = store.searchHybrid({ scope: testScope(), query: "挂载配置", topK: 5 });
    assert.equal(results.length, 1);
    assert.ok(results[0].content.includes("fstab"));
  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("hybrid search matches CJK content via FTS for 3+ char queries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memorax-store-"));
  try {
    const store = new LocalMemoryStore(join(dir, "test.db"));
    const scope = testScope();
    store.insertMemory({ scope, content: "fstab 挂载配置修复流程", memoryType: "semantic",
      idempotencyKey: "fts-key-1", sessionId: "s1",
      embedding: null, embeddingDimensions: null, embeddingModel: null });
    const results = store.searchHybrid({ scope, query: "挂载配置", topK: 5 });
    assert.equal(results.length, 1);
    assert.ok(results[0].content.includes("fstab"));
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hybrid search falls back to LIKE for sub-3-char tokens", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memorax-store-"));
  try {
    const store = new LocalMemoryStore(join(dir, "test.db"));
    const scope = testScope();
    store.insertMemory({ scope, content: "fstab 挂载配置修复流程", memoryType: "semantic",
      idempotencyKey: "fts-key-2", sessionId: "s1",
      embedding: null, embeddingDimensions: null, embeddingModel: null });
    const results = store.searchHybrid({ scope, query: "挂载", topK: 5 });
    assert.equal(results.length, 1);
    assert.ok(results[0].content.includes("挂载"));
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hybrid search filters by repository scope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memorax-store-"));
  try {
    const store = new LocalMemoryStore(join(dir, "test.db"));
    store.insertMemory({ scope: scopedScope("repo-a"), content: "alpha deployment notes",
      memoryType: "semantic", idempotencyKey: "scope-key-1", sessionId: "s1",
      embedding: null, embeddingDimensions: null, embeddingModel: null });
    store.insertMemory({ scope: scopedScope("repo-b"), content: "beta deployment notes",
      memoryType: "semantic", idempotencyKey: "scope-key-2", sessionId: "s1",
      embedding: null, embeddingDimensions: null, embeddingModel: null });
    store.insertMemory({ scope: scopedScope(undefined), content: "gamma global notes",
      memoryType: "semantic", idempotencyKey: "scope-key-3", sessionId: "s1",
      embedding: null, embeddingDimensions: null, embeddingModel: null });

    const repoA = store.searchHybrid({ scope: scopedScope("repo-a"), query: "notes", topK: 5 });
    assert.deepEqual(repoA.map((r) => r.content).sort(), ["alpha deployment notes", "gamma global notes"]);

    const global = store.searchHybrid({ scope: scopedScope(undefined), query: "notes", topK: 5 });
    assert.equal(global.length, 3);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hybrid search fuses vector and keyword candidates from both channels", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memorax-store-"));
  try {
    const store = new LocalMemoryStore(join(dir, "test.db"));
    const scope = testScope();
    const embedFor = (content) => content.includes("alpha")
      ? new Float32Array([1, 0])
      : content.includes("quantum")
        ? new Float32Array([0, 1])
        : new Float32Array([0, 0]);
    for (const [key, content] of [
      ["fuse-key-1", "alpha vector document"],
      ["fuse-key-2", "quantum entanglement reducer"],
      ["fuse-key-3", "zebra stripes unrelated"],
    ]) {
      const vector = embedFor(content);
      store.insertMemory({ scope, content, memoryType: "semantic", idempotencyKey: key,
        sessionId: "s1", embedding: Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
        embeddingDimensions: 2, embeddingModel: "test" });
    }
    const results = store.searchHybrid({
      scope,
      query: "quantum alpha",
      queryVector: new Float32Array([1, 1]),
      topK: 3,
    });
    const contents = results.map((r) => r.content).sort();
    assert.deepEqual(contents, ["alpha vector document", "quantum entanglement reducer"]);

    const reversed = store.searchHybrid({
      scope,
      query: "quantum alpha",
      queryVector: new Float32Array([1, 1]),
      topK: 3,
      rerank: (query, candidates) => [...candidates].reverse(),
    });
    assert.equal(reversed[0].content, results[results.length - 1].content);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
