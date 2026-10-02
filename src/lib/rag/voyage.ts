/**
 * Voyage AI client: embeddings and reranking.
 *
 * Anthropic has no embeddings endpoint, so retrieval uses Voyage (which
 * Anthropic recommends) and Claude handles extraction and composition. Requests
 * are batched by both input count and total characters, because Voyage caps a
 * request on either, and 429s and 5xx are retried with backoff.
 */

import { ragConfig, voyageApiKey } from "./config";

const BASE_URL = "https://api.voyageai.com/v1";
const MAX_ATTEMPTS = 4;

/** `document` for indexed text, `query` for a search string. */
export type InputType = "document" | "query";

interface EmbeddingsResponse {
  data: { index: number; embedding: number[] }[];
  model: string;
  usage?: { total_tokens: number };
}

interface RerankResponse {
  data: { index: number; relevance_score: number }[];
  model: string;
  usage?: { total_tokens: number };
}

export interface EmbedResult {
  /** One vector per input, in input order. */
  embeddings: Float32Array[];
  model: string;
  dimensions: number;
  totalTokens: number;
}

async function post<T>(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${voyageApiKey()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      await backoff(attempt);
      continue;
    }

    if (response.ok) return (await response.json()) as T;

    const detail = await response.text();
    const retryable = response.status === 429 || response.status >= 500;
    lastError = new Error(
      `Voyage ${path} failed: ${response.status} ${detail.slice(0, 300)}`,
    );
    if (!retryable || attempt === MAX_ATTEMPTS) throw lastError;

    const retryAfter = Number(response.headers.get("retry-after"));
    await backoff(attempt, Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined);
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function backoff(attempt: number, explicitMs?: number): Promise<void> {
  const base = explicitMs ?? Math.min(500 * 2 ** (attempt - 1), 8000);
  const jitter = Math.floor(base * 0.25 * Math.random());
  return new Promise((done) => setTimeout(done, base + jitter));
}

/**
 * Split inputs into requests that respect both the count and character caps.
 * An input longer than the whole character budget still gets its own request;
 * Voyage truncates it rather than failing.
 */
function batch(inputs: string[]): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let chars = 0;

  for (let i = 0; i < inputs.length; i += 1) {
    const length = inputs[i].length;
    const full =
      current.length >= ragConfig.embedBatchSize ||
      (current.length > 0 && chars + length > ragConfig.embedBatchChars);

    if (full) {
      batches.push(current);
      current = [];
      chars = 0;
    }

    current.push(i);
    chars += length;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

/** Embed `inputs`, preserving order. Empty input returns an empty result. */
export async function embed(
  inputs: string[],
  inputType: InputType,
  options: { signal?: AbortSignal; model?: string } = {},
): Promise<EmbedResult> {
  const model = options.model ?? ragConfig.embedModel;

  if (inputs.length === 0) {
    return { embeddings: [], model, dimensions: 0, totalTokens: 0 };
  }

  const embeddings = new Array<Float32Array | undefined>(inputs.length);
  let totalTokens = 0;
  let dimensions = 0;

  for (const indices of batch(inputs)) {
    const response = await post<EmbeddingsResponse>(
      "/embeddings",
      {
        model,
        input: indices.map((i) => inputs[i]),
        input_type: inputType,
        truncation: true,
      },
      options.signal,
    );

    totalTokens += response.usage?.total_tokens ?? 0;

    for (const item of response.data) {
      const vector = Float32Array.from(item.embedding);
      dimensions = vector.length;
      embeddings[indices[item.index]] = vector;
    }
  }

  const missing = embeddings.findIndex((vector) => vector === undefined);
  if (missing !== -1) {
    throw new Error(`Voyage returned no embedding for input ${missing}`);
  }

  return {
    embeddings: embeddings as Float32Array[],
    model,
    dimensions,
    totalTokens,
  };
}

/** Convenience wrapper for the one-vector query case. */
export async function embedQuery(
  query: string,
  options: { signal?: AbortSignal } = {},
): Promise<Float32Array> {
  const { embeddings } = await embed([query], "query", options);
  return embeddings[0];
}

export interface RerankScore {
  /** Index into the `documents` array that was passed in. */
  index: number;
  score: number;
}

/** Score `documents` against `query`. Returned highest-scoring first. */
export async function rerank(
  query: string,
  documents: string[],
  options: { signal?: AbortSignal; topK?: number; model?: string } = {},
): Promise<RerankScore[]> {
  if (documents.length === 0) return [];

  const response = await post<RerankResponse>(
    "/rerank",
    {
      model: options.model ?? ragConfig.rerankModel,
      query,
      documents,
      top_k: options.topK ?? documents.length,
      truncation: true,
    },
    options.signal,
  );

  return response.data
    .map((item) => ({ index: item.index, score: item.relevance_score }))
    .sort((a, b) => b.score - a.score);
}

/* --- BLOB encoding ------------------------------------------------------- */

export function encodeVector(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function decodeVector(blob: Uint8Array): Float32Array {
  // A row's BLOB may be a view into a larger buffer at an unaligned offset,
  // so copy before reinterpreting as Float32.
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}
