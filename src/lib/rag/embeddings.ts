/**
 * Embedding providers.
 *
 * - "voyage" (default when VOYAGE_API_KEY is set): Voyage AI, the embedding
 *   provider Anthropic recommends. Model is configurable with VOYAGE_MODEL.
 * - "hash": a deterministic, offline feature-hashing embedder. It needs no
 *   network or key, which makes it useful for tests and for trying the
 *   pipeline, but its retrieval quality is far below a real model. Keyword
 *   search (FTS5) still runs alongside it.
 */

export type InputType = "document" | "query";

export interface Embedder {
  /** Stable id stored with every vector, e.g. "voyage:voyage-3.5". */
  readonly id: string;
  embed(texts: string[], inputType: InputType): Promise<Float32Array[]>;
}

export function createEmbedder(): Embedder {
  const provider =
    process.env.EMBEDDING_PROVIDER || (process.env.VOYAGE_API_KEY ? "voyage" : "");
  switch (provider) {
    case "voyage":
      return new VoyageEmbedder();
    case "hash":
      return new HashEmbedder();
    default:
      throw new Error(
        "No embedding provider configured. Set VOYAGE_API_KEY (recommended), " +
          "or EMBEDDING_PROVIDER=hash for offline testing.",
      );
  }
}

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage?: { total_tokens: number };
}

export class VoyageEmbedder implements Embedder {
  readonly id: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly batchSize = 64;

  constructor(
    apiKey = process.env.VOYAGE_API_KEY,
    model = process.env.VOYAGE_MODEL || "voyage-3.5",
  ) {
    if (!apiKey) throw new Error("VOYAGE_API_KEY is not set");
    this.apiKey = apiKey;
    this.model = model;
    this.id = `voyage:${model}`;
  }

  async embed(texts: string[], inputType: InputType): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const json = await this.request(batch, inputType);
      const ordered = [...json.data].sort((a, b) => a.index - b.index);
      for (const item of ordered) out.push(Float32Array.from(item.embedding));
    }
    return out;
  }

  private async request(input: string[], inputType: InputType): Promise<VoyageResponse> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input, model: this.model, input_type: inputType }),
      });
      if (res.ok) return (await res.json()) as VoyageResponse;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= 4) {
        throw new Error(`Voyage embeddings failed (${res.status}): ${await res.text()}`);
      }
      await sleep(1000 * 2 ** attempt);
    }
  }
}

/**
 * Signed feature hashing over word unigrams and bigrams, L2-normalized.
 * Deterministic and dependency-free. Not a semantic model.
 */
export class HashEmbedder implements Embedder {
  readonly id: string;

  constructor(private readonly dim = 512) {
    this.id = `hash:${dim}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): Float32Array {
    const vec = new Float32Array(this.dim);
    const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    const add = (feature: string, weight: number) => {
      const h = fnv1a(feature);
      const sign = h & 1 ? 1 : -1;
      vec[(h >>> 1) % this.dim] += sign * weight;
    };
    for (let i = 0; i < words.length; i++) {
      add(words[i], 1);
      if (i > 0) add(`${words[i - 1]} ${words[i]}`, 0.5);
    }
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    return vec;
  }
}

function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
