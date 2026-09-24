// A circuit breaker for calls to a flaky dependency. After `failureThreshold` failures in a
// row it opens and rejects calls immediately for `cooldownMs`. The first call after the
// cooldown is let through as a probe: success closes the circuit, failure opens it again.
//
// State lives in memory, so each Worker instance has its own breaker. That is enough to
// stop one instance from waiting on timeouts while a dependency is down.

export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`${name} circuit is open; skipping the call`);
    this.name = "CircuitOpenError";
  }
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  constructor(
    readonly name: string,
    private readonly failureThreshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): "closed" | "open" | "half_open" {
    if (this.openedAt === null) return "closed";
    return this.now() - this.openedAt >= this.cooldownMs ? "half_open" : "open";
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") throw new CircuitOpenError(this.name);
    try {
      const value = await fn();
      this.failures = 0;
      this.openedAt = null;
      return value;
    } catch (err) {
      this.failures += 1;
      if (this.state === "half_open" || this.failures >= this.failureThreshold) this.openedAt = this.now();
      throw err;
    }
  }

  reset() {
    this.failures = 0;
    this.openedAt = null;
  }
}
