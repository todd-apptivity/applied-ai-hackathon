/** Retrieval configuration. Every value is overridable by env. */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const ragConfig = {
  /** Voyage embedding model. 1024 dimensions. */
  embedModel: process.env.VOYAGE_EMBED_MODEL ?? "voyage-4-large",
  rerankModel: process.env.VOYAGE_RERANK_MODEL ?? "rerank-2.5",

  /** Target chunk size in characters, with overlap to keep sentences whole. */
  chunkChars: num("RAG_CHUNK_CHARS", 1600),
  chunkOverlapChars: num("RAG_CHUNK_OVERLAP", 200),

  /**
   * Per-request batching for the embeddings endpoint. Voyage caps a request by
   * both input count and total tokens; the character budget is the token cap
   * with room to spare at ~4 characters per token.
   */
  embedBatchSize: num("RAG_EMBED_BATCH", 96),
  embedBatchChars: num("RAG_EMBED_BATCH_CHARS", 320_000),

  /** Candidates drawn from each retrieval arm before fusion. */
  candidatesPerArm: num("RAG_CANDIDATES", 50),
  /** How many fused candidates are sent to the reranker. */
  rerankCandidates: num("RAG_RERANK_CANDIDATES", 30),
  /** Reciprocal-rank-fusion damping. 60 is the value from the original paper. */
  rrfK: num("RAG_RRF_K", 60),
} as const;

export function voyageApiKey(): string {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) {
    throw new Error(
      "VOYAGE_API_KEY is not set. Add it to .env.local — embeddings and reranking both need it.",
    );
  }
  return key;
}

export function isVoyageConfigured(): boolean {
  return Boolean(process.env.VOYAGE_API_KEY);
}
