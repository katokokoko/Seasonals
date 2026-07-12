/**
 * Seasonals MCP Server — stdio entry (Phase 8.28)
 *
 * 起動: `pnpm --filter @seasonals/mcp-server start` または repo root の
 * .mcp.json 経由 (Claude Code / Claude Desktop が stdio で spawn)。
 * 接続先 BFF は BFF_URL env (default http://localhost:3030)。
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createBffClient } from "./bff-client";
import { buildMcpServer } from "./server";

async function main(): Promise<void> {
  const server = buildMcpServer(createBffClient());
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("Seasonals MCP server ready (stdio)\n");
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
