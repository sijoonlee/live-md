// Minimal in-memory token-bucket rate limiter, keyed by an arbitrary string
// (here, a principal id). Each key gets `capacity` burst tokens that refill at
// `refillPerSec`. `allow` returns false when the bucket is empty. In-process only —
// a multi-instance deployment would move this to a shared store (e.g. Redis).
export function createRateLimiter(options: {capacity: number; refillPerSec: number; now?: () => number}) {
  const buckets = new Map<string, {tokens: number; last: number}>();
  const clock = options.now ?? (() => Date.now());

  return {
    allow(key: string): boolean {
      const time = clock();
      const bucket = buckets.get(key) ?? {tokens: options.capacity, last: time};
      const elapsedSec = Math.max(0, (time - bucket.last) / 1000);
      bucket.tokens = Math.min(options.capacity, bucket.tokens + elapsedSec * options.refillPerSec);
      bucket.last = time;
      buckets.set(key, bucket);
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
  };
}
