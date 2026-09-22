import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadEmbeddingConfig } from "../../../dist/provider/local/config.js";
import { embedText } from "../../../dist/provider/local/embedding.js";

const ARK_KEY = process.env.ARKCODINGPLAN_API_KEY;
const LIVE = process.env.MEMORAX_CODE_LIVE_EMBEDDING_TEST === "1" && ARK_KEY;

function liveConfig() {
  return {
    enabled: true,
    apiKey: ARK_KEY,
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    model: "doubao-embedding-vision",
    timeoutMs: 5000,
  };
}

function stubFetch(status, body) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

async function withEmbeddingFile(json, run) {
  const dir = await mkdtemp(join(tmpdir(), "memorax-embed-"));
  try {
    await writeFile(join(dir, "embedding.json"), JSON.stringify(json));
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("loadEmbeddingConfig returns defaults when file missing", () => {
  const config = loadEmbeddingConfig("/nonexistent/path");
  assert.ok(config);
  assert.equal(config.enabled, true);
  assert.equal(config.model, "doubao-embedding-vision");
  assert.equal(config.timeoutMs, 5000);
  assert.equal(config.baseUrl, "https://ark.cn-beijing.volces.com/api/coding/v3");
});

test("loadEmbeddingConfig reads custom values from file", async () => {
  await withEmbeddingFile({
    enabled: false,
    api_key: "custom-key",
    base_url: "http://custom:8080",
    model: "custom-model",
    timeout_ms: 2000,
  }, async (dir) => {
    const config = loadEmbeddingConfig(dir);
    assert.equal(config.enabled, false);
    assert.equal(config.apiKey, "custom-key");
    assert.equal(config.baseUrl, "http://custom:8080");
    assert.equal(config.model, "custom-model");
    assert.equal(config.timeoutMs, 2000);
  });
});

test("loadEmbeddingConfig resolves env var name in api_key", () => {
  const env = { ARKCODINGPLAN_API_KEY: "resolved-value", MEMORAX_CODE_HOME: "" };
  const config = loadEmbeddingConfig("/tmp/fake-home-for-env-test", env);
  assert.equal(config.apiKey, "resolved-value");
});

test("loadEmbeddingConfig resolves explicit api_key_env field", async () => {
  await withEmbeddingFile({ api_key_env: "MY_CUSTOM_KEY" }, async (dir) => {
    const config = loadEmbeddingConfig(dir, { MY_CUSTOM_KEY: "custom-resolved" });
    assert.equal(config.apiKey, "custom-resolved");
  });
});

test("api_key_env takes priority over literal api_key", async () => {
  await withEmbeddingFile({
    api_key_env: "MY_CUSTOM_KEY",
    api_key: "ALLCAPS_LITERAL",
  }, async (dir) => {
    const env = { MY_CUSTOM_KEY: "from-env", ARKCODINGPLAN_API_KEY: "fallback" };
    const config = loadEmbeddingConfig(dir, env);
    assert.equal(config.apiKey, "from-env");
  });
});

test("all-uppercase literal api_key is used verbatim", async () => {
  await withEmbeddingFile({ api_key: "ALLCAPS_LITERAL" }, async (dir) => {
    const config = loadEmbeddingConfig(dir, { ARKCODINGPLAN_API_KEY: "fallback" });
    assert.equal(config.apiKey, "ALLCAPS_LITERAL");
  });
});

test("empty resolved api_key_env falls back to ARKCODINGPLAN_API_KEY", async () => {
  await withEmbeddingFile({ api_key_env: "MY_CUSTOM_KEY" }, async (dir) => {
    const config = loadEmbeddingConfig(dir, { MY_CUSTOM_KEY: "", ARKCODINGPLAN_API_KEY: "fallback" });
    assert.equal(config.apiKey, "fallback");
  });
});

test("embedText uses injected fetch and parses vector", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: [0.5, -0.25, 1] }] }),
    };
  };
  const result = await embedText("TypeScript strict mode", liveConfig(), fetchImpl);
  assert.ok(result.ok, `expected ok, got: ${result.ok ? "" : result.error}`);
  assert.deepEqual([...result.vector], [0.5, -0.25, 1]);
  assert.equal(result.dimensions, 3);
  assert.equal(result.model, "doubao-embedding-vision");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/embeddings"));
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: "doubao-embedding-vision",
    input: "TypeScript strict mode",
  });
});

test("embedText reports HTTP errors without throwing", async () => {
  const result = await embedText("test", liveConfig(), stubFetch(401, {}));
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("401"));
});

test("embedText reports invalid response format", async () => {
  const result = await embedText("test", liveConfig(), stubFetch(200, { data: [{}] }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid response format");
});

test("embedText returns error when disabled", async () => {
  const config = { ...liveConfig(), enabled: false };
  const result = await embedText("test", config, stubFetch(200, { data: [{ embedding: [1] }] }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "embedding disabled");
});

test("embedText calls Ark API and returns vector", { skip: !LIVE }, async () => {
  const result = await embedText("TypeScript strict mode", liveConfig());
  assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result).slice(0, 200)}`);
  assert.ok(result.vector.length > 0);
  assert.equal(typeof result.vector[0], "number");
});

test("embedText handles API failure gracefully", { skip: !LIVE }, async () => {
  const config = { ...liveConfig(), apiKey: "invalid-key-for-testing", timeoutMs: 2000 };
  const result = await embedText("test", config);
  assert.equal(result.ok, false);
  assert.ok(result.error);
});
