import { sleep } from "./backoff";

// A token bucket that refills continuously. `take()` waits until a token is available.
// State lives in memory, so the limit applies per Worker instance, not globally.
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  private refill() {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.ratePerSecond);
    this.last = t;
  }

  // Milliseconds until a token would be available, or 0 if one is available now.
  waitMs(): number {
    this.refill();
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000);
  }

  async take(): Promise<void> {
    for (let wait = this.waitMs(); wait > 0; wait = this.waitMs()) await sleep(wait);
    this.tokens -= 1;
  }
}
