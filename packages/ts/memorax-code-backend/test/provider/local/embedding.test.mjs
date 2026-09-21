import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadEmbeddingConfig, embedText } from "../../../dist/provider/local/config.js";

const ARK_KEY = process.env.ARKCODINGPLAN_API_KEY;

test("loadEmbeddingConfig returns defaults when file missing", () => {
  const config = loadEmbeddingConfig("/nonexistent/path");
  assert.ok(config);
  assert.equal(config.enabled, true);
  assert.equal(config.model, "doubao-embedding-vision");
  assert.equal(config.timeoutMs, 5000);
  assert.equal(config.baseUrl, "https://ark.cn-beijing.volces.com/api/coding/v3");
});

test("loadEmbeddingConfig reads custom values from file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memorax-embed-"));
  try {
    await writeFile(join(dir, "embedding.json"), JSON.stringify({
      enabled: false,
      api_key: "custom-key",
      base_url: "http://custom:8080",
      model: "custom-model",
      timeout_ms: 2000,
    }));
    const config = loadEmbeddingConfig(dir);
    assert.equal(config.enabled, false);
    assert.equal(config.apiKey, "custom-key");
    assert.equal(config.baseUrl, "http://custom:8080");
    assert.equal(config.model, "custom-model");
    assert.equal(config.timeoutMs, 2000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadEmbeddingConfig resolves env var name in api_key", () => {
  const env = { ARKCODINGPLAN_API_KEY: "resolved-value", MEMORAX_CODE_HOME: "" };
  const dir = "/tmp/fake-home-for-env-test";
  const config = loadEmbeddingConfig(dir, env);
  assert.equal(config.apiKey, "resolved-value");
});

test("embedText calls Ark API and returns vector", { skip: !ARK_KEY }, async () => {
  const config = {
    enabled: true,
    apiKey: ARK_KEY,
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    model: "doubao-embedding-vision",
    timeoutMs: 5000,
  };
  const result = await embedText("TypeScript strict mode", config);
  assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result).slice(0, 200)}`);
  assert.ok(result.vector.length > 0);
  assert.equal(typeof result.vector[0], "number");
});

test("embedText handles API failure gracefully", async () => {
  const config = {
    enabled: true,
    apiKey: "invalid-key-for-testing",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    model: "doubao-embedding-vision",
    timeoutMs: 2000,
  };
  const result = await embedText("test", config);
  assert.equal(result.ok, false);
  assert.ok(result.error);
});
