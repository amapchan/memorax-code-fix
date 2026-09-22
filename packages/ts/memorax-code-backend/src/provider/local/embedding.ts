import type { EmbeddingConfig } from "./config.js";

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
