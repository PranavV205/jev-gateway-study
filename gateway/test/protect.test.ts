import { describe, expect, it } from "vitest";
import { allowedOrigin, startOfUtcDay } from "../src/protect";

const withOrigins = (ALLOWED_ORIGINS: string) => ({ ALLOWED_ORIGINS }) as Env;

describe("allowedOrigin", () => {
  it("echoes an origin on the list and refuses others", () => {
    const env = withOrigins("https://a.pages.dev, https://b.pages.dev");
    expect(allowedOrigin("https://b.pages.dev", env)).toBe("https://b.pages.dev");
    expect(allowedOrigin("https://evil.example", env)).toBeNull();
  });

  it("allows any origin with *", () => {
    expect(allowedOrigin("https://anything.example", withOrigins("*"))).toBe("https://anything.example");
  });
});

describe("startOfUtcDay", () => {
  it("returns midnight UTC of the same day", () => {
    expect(startOfUtcDay(new Date("2026-09-25T17:42:10Z"))).toBe("2026-09-25T00:00:00.000Z");
  });
});
