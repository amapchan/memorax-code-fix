import { join } from "node:path";
import { defaultMemoraxCodeHome } from "../../config/memorax-code.js";
import type { RepositoryMemoryScope } from "../../repository/scope.js";
import { loadEmbeddingConfig, embedText, type EmbeddingConfig } from "./config.js";
import { checkEmbeddingHealth } from "./health.js";
import { LocalMemoryStore } from "./store.js";
import type {
  MemoraxSlotInvocationRequest,
  MemoraxAdapterOptions,
  MemoraxInvocationResult,
} from "../memorax/adapter.js";

export type LocalRunContext = {
  sessionId: string;
  branchId?: string;
  prompt: string;
};

export async function invokeLocalMemoryProvider(
  run: LocalRunContext,
  request: MemoraxSlotInvocationRequest,
  options: MemoraxAdapterOptions = {},
): Promise<MemoraxInvocationResult> {
  const repositoryScope = options.repositoryScope;
  if (!repositoryScope) {
    return { ok: false, error: "memory scope is required for local memory provider" };
  }
  const home = options.env?.MEMORAX_CODE_HOME?.trim() || defaultMemoraxCodeHome(options.env);
  const store = new LocalMemoryStore(join(home, "local-memory.db"));
  try {
    switch (request.operation) {
      case "writeback":
        return await handleWriteback(store, run, request, options, home);
      case "retrieve":
      case "query":
        return await handleRetrieve(store, run, request, options, home);
      default:
        return { ok: false, error: `unsupported local memory operation ${request.operation}` };
    }
  } finally {
    store.close();
  }
}

async function handleWriteback(
  store: LocalMemoryStore,
  run: LocalRunContext,
  request: MemoraxSlotInvocationRequest,
  options: MemoraxAdapterOptions,
  home: string,
): Promise<MemoraxInvocationResult> {
  const context = (request.context && typeof request.context === "object" ? request.context : {}) as Record<string, unknown>;
  const idempotencyKey = typeof context.idempotencyKey === "string" ? context.idempotencyKey.trim() : "";
  if (!idempotencyKey) return { ok: false, error: "writeback idempotency key is required for local memory" };
  const rawMessages = Array.isArray(context.messages) ? context.messages : [];
  const contentParts = rawMessages
    .filter((m): m is Record<string, unknown> => m !== null && typeof m === "object" && typeof (m as Record<string, unknown>).content === "string" && ((m as Record<string, unknown>).content as string).trim().length > 0)
    .map((m) => `${m.role as string}: ${(m.content as string).trim()}`);
  if (contentParts.length === 0) return { ok: false, error: "writeback messages are required" };
  const content = contentParts.join("\n");

  const embedConfig = loadEmbeddingConfig(home, options.env);
  let embeddingBuf: Buffer | null = null;
  let dims: number | null = null;
  let model: string | null = null;
  if (embedConfig.enabled && embedConfig.apiKey) {
    const healthy = await checkEmbeddingHealth(embedConfig);
    if (healthy) {
      const embedResult = await embedText(content.slice(0, 512), embedConfig);
      if (embedResult.ok) {
        embeddingBuf = Buffer.from(embedResult.vector.buffer, embedResult.vector.byteOffset, embedResult.vector.byteLength);
        dims = embedResult.dimensions;
        model = embedResult.model;
      }
    }
  }

  try {
    store.insertMemory({
      scope: options.repositoryScope!,
      content,
      memoryType: "semantic",
      idempotencyKey,
      sessionId: run.sessionId,
      embedding: embeddingBuf,
      embeddingDimensions: dims,
      embeddingModel: model,
    });
  } catch (error) {
    if (String(error).includes("UNIQUE constraint")) {
      return {
        ok: true,
        result: {
          dispatch_receipt: { accepted: true, receipt_id: `local:${idempotencyKey}`, summary: "duplicate accepted" },
          tool_result_payload: { accepted: true, receiptId: `local:${idempotencyKey}` },
        },
      };
    }
    throw error;
  }
  return {
    ok: true,
    result: {
      dispatch_receipt: { accepted: true, receipt_id: `local:${idempotencyKey}`, summary: `stored ${contentParts.length} message(s)` },
      tool_result_payload: { accepted: true, receiptId: `local:${idempotencyKey}` },
    },
  };
}

async function handleRetrieve(
  store: LocalMemoryStore,
  run: LocalRunContext,
  request: MemoraxSlotInvocationRequest,
  options: MemoraxAdapterOptions,
  home: string,
): Promise<MemoraxInvocationResult> {
  const query = typeof request.query === "string" && request.query.trim()
    ? request.query.trim()
    : run.prompt.trim();
  if (!query) return { ok: false, error: "query is required" };
  const embedConfig = loadEmbeddingConfig(home, options.env);
  const topK = 6;

  if (embedConfig.enabled && embedConfig.apiKey) {
    const healthy = await checkEmbeddingHealth(embedConfig);
    if (healthy) {
      const embedResult = await embedText(query, embedConfig);
      if (embedResult.ok) {
        const results = store.searchByVector({
          scope: options.repositoryScope!,
          queryVector: embedResult.vector,
          topK,
          minScore: 0.3,
        });
        if (results.length > 0) return formatResults(results);
      }
    }
  }

  const results = store.searchByKeyword({ scope: options.repositoryScope!, query, topK });
  return formatResults(results);
}

function formatResults(results: Array<{ content: string; memoryType: string; updatedAt: number }>): MemoraxInvocationResult {
  if (results.length === 0) {
    return {
      ok: true,
      result: {
        tool_result_payload: { answer: "", items: [], contextBlocks: [] },
        dispatch_receipt: { accepted: true, receipt_id: `local:${Date.now()}`, summary: "retrieved 0 item(s)" },
      },
    };
  }
  const items = results.map((r) => ({
    memory: r.content,
    metadata: { memory_type: r.memoryType },
    updated_at: r.updatedAt,
  }));
  const contextText = `<memories>\n  <facts>\n${items.map((i) => `   - ${i.memory}`).join("\n")}\n  </facts>\n</memories>`;
  return {
    ok: true,
    result: {
      tool_result_payload: {
        answer: contextText,
        items,
        contextBlocks: [{ type: "memory_context", source: "local", content: contextText, itemCount: items.length }],
      },
      dispatch_receipt: { accepted: true, receipt_id: `local:${Date.now()}`, summary: `retrieved ${items.length} item(s)` },
    },
  };
}

