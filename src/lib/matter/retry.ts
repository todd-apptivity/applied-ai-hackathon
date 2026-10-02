/**
 * A live read has no cache to fall back on, so a dropped connection would
 * otherwise be a failed page. `fetch` reports those as a TypeError; anything
 * Clio actually answered (an auth or API error) is not retried.
 */
export async function retryOnNetworkFailure<T>(read: () => Promise<T>, attempts = 3, waitMs = 400): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof TypeError) || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, waitMs * attempt));
    }
  }
}
