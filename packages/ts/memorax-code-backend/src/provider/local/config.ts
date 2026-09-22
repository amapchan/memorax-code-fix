import { readFileSync } from "node:fs";
import { join } from "node:path";

export type EmbeddingConfig = Readonly<{
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}>;

const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  enabled: true,
  apiKey: "",
  baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
  model: "doubao-embedding-vision",
  timeoutMs: 5000,
};

export function loadEmbeddingConfig(
  memoraxCodeHome: string,
  env: Record<string, string | undefined> = process.env,
): EmbeddingConfig {
  let fileConfig: {
    enabled?: boolean;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    timeoutMs?: number;
  } = {};
  try {
    const raw = readFileSync(join(memoraxCodeHome, "embedding.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    fileConfig = {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : undefined,
      apiKey: typeof parsed.api_key === "string" ? parsed.api_key.trim() : undefined,
      baseUrl: typeof parsed.base_url === "string" ? parsed.base_url.trim() : undefined,
      model: typeof parsed.model === "string" ? parsed.model.trim() : undefined,
      timeoutMs: typeof parsed.timeout_ms === "number" && parsed.timeout_ms > 0 ? parsed.timeout_ms : undefined,
    };
  } catch {
    // File missing or invalid → use defaults
  }

  let apiKey = fileConfig.apiKey ?? "";
  if (apiKey && /^[A-Z][A-Z0-9_]+$/.test(apiKey)) {
    apiKey = env[apiKey] ?? "";
  }
  if (!apiKey) {
    apiKey = env.ARKCODINGPLAN_API_KEY ?? "";
  }

  return {
    enabled: fileConfig.enabled ?? DEFAULT_EMBEDDING_CONFIG.enabled,
    apiKey,
    baseUrl: fileConfig.baseUrl ?? DEFAULT_EMBEDDING_CONFIG.baseUrl,
    model: fileConfig.model ?? DEFAULT_EMBEDDING_CONFIG.model,
    timeoutMs: fileConfig.timeoutMs ?? DEFAULT_EMBEDDING_CONFIG.timeoutMs,
  };
}

export type EmbeddingResult =
  | { ok: true; vector: Float32Array; dimensions: number; model: string }
  | { ok: false; error: string };

export async function embedText(
  text: string,
  config: EmbeddingConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<EmbeddingResult> {
  if (!config.enabled) return { ok: false, error: "embedding disabled" };
  if (!config.apiKey) return { ok: false, error: "no api key" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(`${config.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: config.model, input: text }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const body = await response.json() as { data?: Array<{ embedding?: number[] }> };
    const embedding = body?.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      return { ok: false, error: "invalid response format" };
    }
    return {
      ok: true,
      vector: new Float32Array(embedding),
      dimensions: embedding.length,
      model: config.model,
    };
  } catch (error) {
    clearTimeout(timer);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
