/**
 * Seasonals Web — Vite config
 *
 * - `@workspace/lib` は build step の無い raw TS なので alias で直接解決する
 *   (mobile の tsconfig paths と同じ規約、CLAUDE.md §1)。
 * - `/api/*` は BFF (Fastify, 既定 127.0.0.1:3030) へ proxy する。RPC / API key は
 *   BFF 側 `.env` のみに存在し、client bundle には一切入らない。
 *   `BFF_URL` は node 側 (この config) でのみ読む。`VITE_` prefix は使わない。
 */
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const libDir = fileURLToPath(new URL("../../lib", import.meta.url));
const bffUrl = process.env.BFF_URL ?? "http://127.0.0.1:3030";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [{ find: /^@workspace\/lib/, replacement: libDir }],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: bffUrl,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
  preview: { port: 4173, strictPort: true },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
  },
});
