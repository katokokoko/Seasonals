/**
 * http — readableUpstreamError (Phase 8.78)。
 *
 * node-fetch (isomorphic-fetch 由来の global 上書き) の AbortError message
 * "The user aborted a request." が 502 の message として mobile に出ると、
 * ユーザーが自分で中断したように読める。timeout 系だけ書き換え、それ以外は透過。
 */
import { readableUpstreamError } from "./http";

describe("readableUpstreamError", () => {
  it("node-fetch の abort 文言 → 上流 timeout の説明に置換", () => {
    const err = Object.assign(new Error("The user aborted a request."), {
      name: "AbortError",
    });
    expect(readableUpstreamError(err, "Jupiter API")).toBe(
      "Jupiter API timed out — nothing was signed. Try again."
    );
  });

  it("undici の TimeoutError / abort 文言も同様", () => {
    const t = Object.assign(new Error("The operation was aborted."), {
      name: "TimeoutError",
    });
    expect(readableUpstreamError(t, "Kamino API")).toMatch(/timed out/);
    expect(readableUpstreamError(new Error("This operation was aborted"), "X")).toMatch(
      /timed out/
    );
  });

  it("timeout 系でないエラーは message を透過する (情報を失わない)", () => {
    expect(
      readableUpstreamError(new Error("HTTP 429"), "Jupiter API")
    ).toBe("HTTP 429");
    expect(readableUpstreamError("plain string", "X")).toBe("plain string");
  });
});
