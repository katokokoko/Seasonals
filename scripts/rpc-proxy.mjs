/**
 * rpc-proxy.mjs — 127.0.0.1 専用の JSON-RPC 転送 (Anvil fork 用、docs/web/WORKLOG.md)
 * anvil は fork URL を argv でしか受け取らないため、key 入り URL を process 一覧に出さないよう
 * anvil にはこの proxy (key を含まない URL) を渡す。上流 URL は env UPSTREAM_RPC_URL のみ。
 */
import http from "node:http";

const upstream = process.env.UPSTREAM_RPC_URL;
const port = Number(process.env.RPC_PROXY_PORT ?? 8546);
if (!upstream) {
  console.error("UPSTREAM_RPC_URL is not set");
  process.exit(1);
}
http
  .createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      const r = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: Buffer.concat(chunks) });
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "upstream unavailable" } }));
    }
  })
  .listen(port, "127.0.0.1", () => console.log(`rpc-proxy on 127.0.0.1:${port}`));
