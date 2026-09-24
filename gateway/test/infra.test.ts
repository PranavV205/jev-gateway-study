import { describe, expect, it } from "vitest";
import { backoffMs, retryAfterMs } from "../src/infra/backoff";
import { CircuitBreaker, CircuitOpenError } from "../src/infra/circuit";
import { TokenBucket } from "../src/infra/ratelimit";

describe("backoffMs", () => {
  const policy = { backoffInitialMs: 300, backoffMaxMs: 2000 };

  it("doubles the ceiling each attempt up to the maximum", () => {
    const max = () => 1;
    expect([0, 1, 2, 3, 4].map((a) => backoffMs(a, policy, max))).toEqual([300, 600, 1200, 2000, 2000]);
  });

  it("picks a random wait below the ceiling", () => {
    expect(backoffMs(1, policy, () => 0.5)).toBe(300);
    expect(backoffMs(1, policy, () => 0)).toBe(0);
  });
});

describe("retryAfterMs", () => {
  it("reads seconds and HTTP dates", () => {
    expect(retryAfterMs("2")).toBe(2000);
    expect(retryAfterMs("0.5")).toBe(500);
    const now = Date.parse("2026-09-24T10:00:00Z");
    expect(retryAfterMs("Thu, 24 Sep 2026 10:00:30 GMT", now)).toBe(30_000);
  });

  it("returns null for a missing or unreadable header", () => {
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs("soon")).toBeNull();
  });
});

describe("CircuitBreaker", () => {
  const fail = () => Promise.reject(new Error("down"));
  const ok = () => Promise.resolve("up");

  function breaker() {
    let t = 0;
    const b = new CircuitBreaker("test", 3, 1000, () => t);
    return { b, advance: (ms: number) => (t += ms) };
  }

  it("opens after the threshold and rejects without calling", async () => {
    const { b } = breaker();
    for (let i = 0; i < 3; i++) await expect(b.run(fail)).rejects.toThrow("down");
    expect(b.state).toBe("open");
    let called = false;
    await expect(
      b.run(async () => {
        called = true;
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false);
  });

  it("a success resets the failure count", async () => {
    const { b } = breaker();
    await expect(b.run(fail)).rejects.toThrow();
    await expect(b.run(fail)).rejects.toThrow();
    await b.run(ok);
    await expect(b.run(fail)).rejects.toThrow();
    expect(b.state).toBe("closed");
  });

  it("lets one probe through after the cooldown and closes on success", async () => {
    const { b, advance } = breaker();
    for (let i = 0; i < 3; i++) await expect(b.run(fail)).rejects.toThrow();
    advance(1000);
    expect(b.state).toBe("half_open");
    await expect(b.run(ok)).resolves.toBe("up");
    expect(b.state).toBe("closed");
  });

  it("reopens when the probe fails", async () => {
    const { b, advance } = breaker();
    for (let i = 0; i < 3; i++) await expect(b.run(fail)).rejects.toThrow();
    advance(1000);
    await expect(b.run(fail)).rejects.toThrow("down");
    expect(b.state).toBe("open");
  });
});

describe("TokenBucket", () => {
  it("allows a burst, then refills at the set rate", () => {
    let t = 0;
    const bucket = new TokenBucket(10, 2, () => t);
    expect(bucket.waitMs()).toBe(0);
    // Spend the burst directly through waitMs/take semantics.
    void bucket.take();
    void bucket.take();
    expect(bucket.waitMs()).toBe(100);
    t += 50;
    expect(bucket.waitMs()).toBe(50);
    t += 50;
    expect(bucket.waitMs()).toBe(0);
  });
});
