import { throttledFetch } from "./client";

test("throttledFetch spaces eth_getLogs calls and caps concurrency", async () => {
  const starts: Array<{ t: number; logs: boolean }> = [];
  let inFlight = 0;
  let maxSeen = 0;
  const fake = (async (_u: unknown, init?: { body?: string }) => {
    inFlight++;
    maxSeen = Math.max(maxSeen, inFlight);
    starts.push({ t: Date.now(), logs: Boolean(init?.body?.includes("eth_getLogs")) });
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return new Response("{}");
  }) as unknown as typeof fetch;
  const f = throttledFetch(2, 1, fake);
  const body = (m: string) => ({ method: "POST", body: JSON.stringify({ method: m }) });
  await Promise.all([f("x", body("eth_getLogs")), f("x", body("eth_call")), f("x", body("eth_getLogs")), f("x", body("eth_call"))]);
  const logs = starts.filter((s) => s.logs);
  expect(logs).toHaveLength(2);
  expect(logs[1]!.t - logs[0]!.t).toBeGreaterThanOrEqual(650);
  expect(maxSeen).toBeLessThanOrEqual(2);
});

test("light reads overtake queued eth_getLogs", async () => {
  const order: string[] = [];
  const fake = (async (_u: unknown, init?: { body?: string }) => {
    order.push(JSON.parse(init!.body!).method);
    return new Response("{}");
  }) as unknown as typeof fetch;
  const f = throttledFetch(4, 1, fake);
  const body = (m: string) => ({ method: "POST", body: JSON.stringify({ method: m }) });
  await Promise.all([f("x", body("eth_getLogs")), f("x", body("eth_getLogs")), f("x", body("eth_getLogs")), f("x", body("eth_call"))]);
  expect(order.indexOf("eth_call")).toBeLessThan(2);
});
