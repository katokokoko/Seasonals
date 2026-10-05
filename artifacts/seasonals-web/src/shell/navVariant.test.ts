import { NAV_VARIANT_KEY, resolveNavVariant } from "./navVariant";

function memoryStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe("resolveNavVariant", () => {
  it("defaults to clear glass", () => {
    expect(resolveNavVariant("", memoryStorage())).toBe("clear");
    expect(resolveNavVariant("?nav=whatever", memoryStorage())).toBe("clear");
  });
  it("reads ?nav=droplet and keeps it for the tab", () => {
    const s = memoryStorage();
    expect(resolveNavVariant("?nav=droplet", s)).toBe("droplet");
    expect(s.m.get(NAV_VARIANT_KEY)).toBe("droplet");
    expect(resolveNavVariant("", s)).toBe("droplet");
  });
  it("?nav=clear switches back", () => {
    const s = memoryStorage({ [NAV_VARIANT_KEY]: "droplet" });
    expect(resolveNavVariant("?nav=clear", s)).toBe("clear");
    expect(resolveNavVariant("", s)).toBe("clear");
  });
  it("works without storage or when storage throws", () => {
    expect(resolveNavVariant("?nav=droplet", null)).toBe("droplet");
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(resolveNavVariant("?nav=droplet", throwing)).toBe("droplet");
    expect(resolveNavVariant("", throwing)).toBe("clear");
  });
});
