import { base64ToBytes, bytesToBase64 } from "./bytes";

test("全 256 byte 値を往復しても変わらない", () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  expect(base64ToBytes(bytesToBase64(all))).toEqual(all);
});

test("tx 大の bytes と 32KB 超の bytes も往復する", () => {
  for (const n of [1232, 70_000]) {
    const b = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) % 256);
    expect(base64ToBytes(bytesToBase64(b))).toEqual(b);
  }
});

test("Node の Buffer と同じ base64 を出す", () => {
  const b = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  expect(bytesToBase64(b)).toBe(Buffer.from(b).toString("base64"));
});
