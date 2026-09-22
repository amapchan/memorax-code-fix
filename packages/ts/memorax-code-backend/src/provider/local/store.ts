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

export type MemoryScope = Pick<RepositoryMemoryScope, "effectiveUserId" | "repositorySlug">;

export type HybridSearchParams = {
  scope: MemoryScope;
  query: string;
  queryVector?: Float32Array | null;
  topK: number;
  candidateLimit?: number;
  rerank?: (query: string, candidates: StoredMemory[]) => StoredMemory[];
};

const RRF_K = 60;
const VECTOR_CANDIDATE_MIN_SCORE = 0.1;

const MEMORY_COLUMNS = "id, content, memory_type, embedding, embedding_dimensions, embedding_model, created_at, updated_at";

export class LocalMemoryStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    // WAL + busy_timeout make concurrent access from the Backend and the
    // memorax-cli process safe without additional cross-process locking.
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA busy_timeout=2000;");
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
    this.migrateFts();
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
      id, params.scope.effectiveUserId, params.scope.repositorySlug ?? null,
      params.content, params.memoryType,
      // Copy so a Buffer view over a larger pooled ArrayBuffer cannot leak
      // extra bytes into the BLOB.
      params.embedding ? Buffer.from(params.embedding) : null,
      params.embeddingDimensions, params.embeddingModel,
      params.sessionId ?? null, params.idempotencyKey, now, now,
    );
    return id;
  }

  searchByKeyword(input: { scope: MemoryScope; query: string; topK: number }): StoredMemory[] {
    const scope = this.scopeClause(input.scope);
    const rows = this.db.prepare(`
      SELECT ${MEMORY_COLUMNS}
      FROM memories
      WHERE ${scope.sql} AND content LIKE '%' || ? || '%'
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(...scope.params, input.query, input.topK);
    return rows.map((row) => this.rowToMemory(row as Record<string, unknown>));
  }

  searchByVector(input: {
    scope: MemoryScope;
    queryVector: Float32Array;
    topK: number;
    minScore?: number;
  }): StoredMemory[] {
    const scope = this.scopeClause(input.scope);
    const rows = this.db.prepare(`
      SELECT ${MEMORY_COLUMNS}
      FROM memories
      WHERE ${scope.sql} AND embedding IS NOT NULL
    `).all(...scope.params);
    const scored = rows.map((row) => {
      const r = row as Record<string, unknown>;
      const emb = r.embedding as Buffer;
      const vec = this.embeddingToVector(emb);
      return { ...this.rowToMemory(r), score: cosineSimilarity(input.queryVector, vec) };
    }).filter((r) => input.minScore === undefined || r.score! >= input.minScore);
    scored.sort((a, b) => b.score! - a.score!);
    return scored.slice(0, input.topK);
  }

  searchHybrid(input: HybridSearchParams): StoredMemory[] {
    const candidateLimit = input.candidateLimit ?? 20;
    const vectorCandidates = input.queryVector
      ? this.searchByVector({
        scope: input.scope,
        queryVector: input.queryVector,
        topK: candidateLimit,
        minScore: VECTOR_CANDIDATE_MIN_SCORE,
      }).map((memory, index) => ({ memory, rank: index + 1 }))
      : [];
    const keywordCandidates = this.searchKeywordCandidates(input.scope, input.query, candidateLimit)
      .map((memory, index) => ({ memory, rank: index + 1 }));

    const fused = new Map<string, { memory: StoredMemory; score: number }>();
    const addCandidates = (candidates: Array<{ memory: StoredMemory; rank: number }>) => {
      for (const { memory, rank } of candidates) {
        const entry = fused.get(memory.id) ?? { memory, score: 0 };
        entry.score += 1 / (RRF_K + rank);
        fused.set(memory.id, entry);
      }
    };
    addCandidates(vectorCandidates);
    addCandidates(keywordCandidates);
    let ranked: StoredMemory[] = [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .map((entry) => ({ ...entry.memory, score: entry.score }));
    if (input.rerank) ranked = input.rerank(input.query, ranked);
    // Rank-based cutoff only: RRF scores are not comparable to an absolute
    // similarity threshold, so no min-score filter is applied after fusion.
    return ranked.slice(0, input.topK);
  }

  close(): void {
    this.db.close();
  }

  private searchKeywordCandidates(
    scope: MemoryScope,
    query: string,
    limit: number,
  ): StoredMemory[] {
    const tokens = queryTokens(query);
    const ftsTokens = tokens.filter((token) => [...token].length >= 3);
    const shortTokens = tokens.filter((token) => [...token].length < 3);
    const candidates = new Map<string, StoredMemory>();
    if (ftsTokens.length > 0) {
      // FTS5 covers tokens of >=3 characters; trigram cannot match shorter
      // ones. Any FTS error falls back to LIKE so retrieval never crashes.
      try {
        const match = ftsTokens.map(ftsQuote).join(" OR ");
        const where = this.scopeClause(scope);
        const rows = this.db.prepare(`
          SELECT m.id, m.content, m.memory_type, m.embedding,
            m.embedding_dimensions, m.embedding_model, m.created_at, m.updated_at
          FROM memories_fts f
          JOIN memories m ON m.rowid = f.rowid
          WHERE memories_fts MATCH ? AND ${where.sql}
          ORDER BY bm25(memories_fts)
          LIMIT ?
        `).all(match, ...where.params, limit);
        for (const row of rows) {
          const memory = this.rowToMemory(row as Record<string, unknown>);
          candidates.set(memory.id, memory);
        }
      } catch {
        // fall through to LIKE below
      }
    }
    for (const token of shortTokens.length > 0 ? shortTokens : (ftsTokens.length === 0 ? [query] : [])) {
      for (const memory of this.searchByKeyword({ scope, query: token, topK: limit })) {
        candidates.set(memory.id, memory);
      }
    }
    return [...candidates.values()];
  }

  private scopeClause(scope: MemoryScope): { sql: string; params: unknown[] } {
    if (scope.repositorySlug) {
      return {
        sql: "user_id = ? AND (repository_slug = ? OR repository_slug IS NULL)",
        params: [scope.effectiveUserId, scope.repositorySlug],
      };
    }
    return { sql: "user_id = ?", params: [scope.effectiveUserId] };
  }

  private migrateFts(): void {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content, content='memories', content_rowid='rowid', tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `);
    // count(*) on an external-content FTS table reads the content table, so
    // row counts cannot detect a stale index. A meta marker records whether
    // the one-time backfill for pre-FTS databases has run; triggers keep the
    // index in sync afterwards.
    this.db.exec("CREATE TABLE IF NOT EXISTS memories_fts_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    const backfilled = this.db.prepare("SELECT value FROM memories_fts_meta WHERE key = 'fts_backfilled'").get();
    if (!backfilled) {
      this.db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild');");
      this.db.prepare("INSERT OR REPLACE INTO memories_fts_meta (key, value) VALUES ('fts_backfilled', '1')").run();
    }
  }

  private embeddingToVector(emb: Buffer): Float32Array {
    // Copy before viewing: node:sqlite may return buffers at offsets that are
    // not 4-byte aligned, and the view must not alias SQLite's memory.
    const copy = Buffer.from(emb);
    return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
  }

  private rowToMemory(row: Record<string, unknown>): StoredMemory {
    return {
      id: row.id as string,
      content: row.content as string,
      memoryType: row.memory_type as string,
      embedding: row.embedding ? Buffer.from(row.embedding as Buffer) : null,
      embeddingDimensions: (row.embedding_dimensions as number) ?? null,
      embeddingModel: (row.embedding_model as string) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}

function queryTokens(query: string): string[] {
  return query.split(/[\s,.;:!?"'()\[\]{}<>\/\\|@#$%^&*+=~`]+/u).map((token) => token.trim()).filter(Boolean);
}

function ftsQuote(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
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
