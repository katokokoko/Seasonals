import { describe, expect, it } from "vitest";
import { timelineRetryMs } from "./queries";

describe("timelineRetryMs", () => {
  it("backs off from 15 s and caps at 5 min", () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(timelineRetryMs)).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
    expect(timelineRetryMs(0)).toBe(15_000);
  });
});
