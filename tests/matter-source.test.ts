/**
 * A live read has no cache behind it, so dropped connections are retried.
 * The retry helper is tested on its own; it needs no Clio.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { retryOnNetworkFailure } from "../src/lib/matter/retry";

describe("retryOnNetworkFailure", () => {
  it("retries a dropped connection and returns the first success", async () => {
    let calls = 0;
    const value = await retryOnNetworkFailure(async () => {
      calls += 1;
      if (calls < 3) throw new TypeError("fetch failed");
      return "ok";
    }, 3, 0);
    assert.equal(value, "ok");
    assert.equal(calls, 3);
  });

  it("gives up after the last attempt", async () => {
    let calls = 0;
    await assert.rejects(() => retryOnNetworkFailure(async () => { calls += 1; throw new TypeError("fetch failed"); }, 2, 0), TypeError);
    assert.equal(calls, 2);
  });

  it("does not retry an error the server actually answered with", async () => {
    let calls = 0;
    await assert.rejects(() => retryOnNetworkFailure(async () => { calls += 1; throw new Error("401 from Clio"); }, 3, 0));
    assert.equal(calls, 1);
  });
});
