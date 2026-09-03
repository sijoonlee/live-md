import assert from "node:assert/strict";
import {test} from "node:test";
import {createRateLimiter} from "../../src/rate-limit.js";

test("allows up to capacity, then blocks until refill", () => {
  let clock = 1000;
  const limiter = createRateLimiter({capacity: 3, refillPerSec: 1, now: () => clock});

  // Burst of 3 is allowed, the 4th is blocked.
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), false);

  // After 1s, one token refills.
  clock += 1000;
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), false);
});

test("buckets are independent per key", () => {
  let clock = 0;
  const limiter = createRateLimiter({capacity: 1, refillPerSec: 1, now: () => clock});
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), false);
  // A different key has its own full bucket.
  assert.equal(limiter.allow("b"), true);
});
