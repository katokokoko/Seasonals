/**
 * CLAUDE.md §6: 色は DS token 経由。src 配下の CSS / TS(X) に hex 直書きが無いことを保証する
 * (shader の .glsl は spec 通り baked palette を持つので対象外)。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(process.cwd(), "src");
const HEX = /(^|[^&\w])#[0-9a-fA-F]{3,8}\b/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test("no hex color literals in src (except shader)", () => {
  const offenders = walk(SRC)
    .filter((p) => /\.(css|tsx?)$/.test(p) && !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .filter((p) => readFileSync(p, "utf8").split("\n").some((line) => HEX.test(line) && !line.includes("no-hex-ok")));
  expect(offenders).toEqual([]);
});
