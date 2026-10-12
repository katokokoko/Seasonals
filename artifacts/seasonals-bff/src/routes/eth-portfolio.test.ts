import Fastify, { type FastifyInstance } from "fastify";

import { registerEthRoutes } from "./eth";

const ADDR = "0x1111111111111111111111111111111111111111";
let app: FastifyInstance;
let prevKey: string | undefined;

beforeAll(async () => {
  prevKey = process.env.ETHERSCAN_API_KEY;
  delete process.env.ETHERSCAN_API_KEY;
  app = Fastify();
  await registerEthRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (prevKey !== undefined) process.env.ETHERSCAN_API_KEY = prevKey;
});

describe("/eth/portfolio/*", () => {
  it("rejects non-EVM addresses with 400", async () => {
    const res = await app.inject({ method: "GET", url: "/eth/portfolio/history?address=abc" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_address");
  });

  it("returns 503 etherscan_not_configured without a key (never an empty success)", async () => {
    for (const path of ["history", "holdings"]) {
      const res = await app.inject({ method: "GET", url: `/eth/portfolio/${path}?address=${ADDR}&days=30` });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("etherscan_not_configured");
    }
  });
});
