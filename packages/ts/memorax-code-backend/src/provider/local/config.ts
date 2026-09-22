import { readFileSync } from "node:fs";
import { join } from "node:path";

export type EmbeddingConfig = Readonly<{
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}>;

export type EmbeddingFileConfig = {
  enabled?: boolean;
  api_key_env?: string;
  api_key?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
};

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
  let fileConfig: EmbeddingFileConfig = {};
  try {
    const raw = readFileSync(join(memoraxCodeHome, "embedding.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    fileConfig = {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : undefined,
      api_key_env: typeof parsed.api_key_env === "string" ? parsed.api_key_env.trim() : undefined,
      api_key: typeof parsed.api_key === "string" ? parsed.api_key.trim() : undefined,
      baseUrl: typeof parsed.base_url === "string" ? parsed.base_url.trim() : undefined,
      model: typeof parsed.model === "string" ? parsed.model.trim() : undefined,
      timeoutMs: typeof parsed.timeout_ms === "number" && parsed.timeout_ms > 0 ? parsed.timeout_ms : undefined,
    };
  } catch {
    // File missing or invalid → use defaults
  }

  // Explicit resolution: api_key_env names an environment variable, api_key
  // is a literal value, and ARKCODINGPLAN_API_KEY is the built-in default.
  // The old all-uppercase heuristic is gone: uppercase literal keys are no
  // longer misread as variable names.
  let apiKey = fileConfig.api_key_env
    ? env[fileConfig.api_key_env] ?? ""
    : fileConfig.api_key ?? "";
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
