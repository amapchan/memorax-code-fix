import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { RepositoryMemoryScope } from "../../repository/scope.js";

export type InsertMemoryParams = {
  scope: Pick<RepositoryMemoryScope, "effectiveUserId" | "repositorySlug">;
  content: string;
  memoryType: string;
  idempotencyKey: string;
  sessionId?: string;
  embedding: Buffer | null;
  embeddingDimensions: number | null;
  embeddingModel: string | null;
};

export type StoredMemory = {
  id: string;
  content: string;
  memoryType: string;
  embedding: Buffer | null;
  embeddingDimensions: number | null;
  embeddingModel: string | null;
  createdAt: number;
  updatedAt: number;
  score?: number;
};

export type MemoryScope = Pick<RepositoryMemoryScope, "effectiveUserId">;

export class LocalMemoryStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        repository_slug TEXT,
        content TEXT NOT NULL,
        memory_type TEXT NOT NULL DEFAULT 'semantic',
        embedding BLOB,
        embedding_dimensions INTEGER,
        embedding_model TEXT,
        session_id TEXT,
        idempotency_key TEXT UNIQUE,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(user_id, memory_type);
    `);
  }

  insertMemory(params: InsertMemoryParams): string {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO memories (id, user_id, repository_slug, content, memory_type,
        embedding, embedding_dimensions, embedding_model, session_id,
        idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, params.scope.effectiveUserId, params.scope.repositorySlug,
      params.content, params.memoryType,
      params.embedding, params.embeddingDimensions, params.embeddingModel,
      params.sessionId ?? null, params.idempotencyKey, now, now,
    );
    return id;
  }

  searchByKeyword(input: { scope: MemoryScope; query: string; topK: number }): StoredMemory[] {
    const rows = this.db.prepare(`
      SELECT id, content, memory_type, embedding, embedding_dimensions,
        embedding_model, created_at, updated_at
      FROM memories
      WHERE user_id = ? AND content LIKE '%' || ? || '%'
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(input.scope.effectiveUserId, input.query, input.topK);
    return rows.map((row) => this.rowToMemory(row as Record<string, unknown>));
  }

  searchByVector(input: {
    scope: MemoryScope;
    queryVector: Float32Array;
    topK: number;
    minScore?: number;
  }): StoredMemory[] {
    const rows = this.db.prepare(`
      SELECT id, content, memory_type, embedding, embedding_dimensions,
        embedding_model, created_at, updated_at
      FROM memories
      WHERE user_id = ? AND embedding IS NOT NULL
    `).all(input.scope.effectiveUserId);
    const scored = rows.map((row) => {
      const r = row as Record<string, unknown>;
      const emb = r.embedding as Buffer;
      const vec = new Float32Array(emb.buffer, emb.byteOffset, emb.byteLength / 4);
      return { ...this.rowToMemory(r), score: cosineSimilarity(input.queryVector, vec) };
    }).filter((r) => input.minScore === undefined || r.score! >= input.minScore);
    scored.sort((a, b) => b.score! - a.score!);
    return scored.slice(0, input.topK);
  }

  close(): void {
    this.db.close();
  }

  private rowToMemory(row: Record<string, unknown>): StoredMemory {
    return {
      id: row.id as string,
      content: row.content as string,
      memoryType: row.memory_type as string,
      embedding: (row.embedding as Buffer) ?? null,
      embeddingDimensions: (row.embedding_dimensions as number) ?? null,
      embeddingModel: (row.embedding_model as string) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
