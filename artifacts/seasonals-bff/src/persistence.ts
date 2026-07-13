/**
 * persistence — 最小の file-backed JSON 永続化 (Phase 8.30)
 *
 * §17/§25 の Redis + Postgres 本実装の前段。plan/token は短命なので対象外とし、
 * **policy override と autonomous 監査ログ**という「再起動後も残したい 2 つ」だけを
 * JSON ファイルに保存する。マルチクライアント (Seeker/web/…) が同じ BFF を共有
 * する時、Seeker で設定した policy が再起動後・別クライアントからも見える、という
 * "same source of truth を永続化する" 最小の土台。
 *
 * ## opt-in / hermetic
 * `SEASONALS_DATA_DIR` が設定されている時のみ有効。未設定 (jest / CI) では
 * load/save は no-op なので、既存テストは disk に触れず hermetic なまま
 * (`_reset*ForTest()` のインメモリ挙動を壊さない)。index.ts (実起動) が
 * default dir を設定する。
 *
 * best-effort: 保存失敗はリクエスト/サイクルを壊さない (warn せず握りつぶす)。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function dataDir(): string | null {
  const dir = process.env.SEASONALS_DATA_DIR;
  return dir && dir.length > 0 ? dir : null;
}

/** 永続化が有効か (SEASONALS_DATA_DIR が設定済みか) */
export function isPersistenceEnabled(): boolean {
  return dataDir() !== null;
}

/** `<dataDir>/<name>.json` を読む。無効/不在/壊れは null。 */
export function loadJson<T>(name: string): T | null {
  const dir = dataDir();
  if (!dir) return null;
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null; // 壊れたファイルは無視 (fresh start)
  }
}

/** `<dataDir>/<name>.json` へ書く。無効時は no-op、失敗は握りつぶす。 */
export function saveJson(name: string, value: unknown): void {
  const dir = dataDir();
  if (!dir) return;
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(value, null, 2));
  } catch {
    // best-effort: 永続化失敗はサイクル/リクエストを壊さない
  }
}
