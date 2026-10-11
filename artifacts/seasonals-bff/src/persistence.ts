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

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { access, mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

function dataDir(): string | null {
  const dir = process.env.SEASONALS_DATA_DIR;
  return dir && dir.length > 0 ? dir : null;
}

/** 永続化が有効か (SEASONALS_DATA_DIR が設定済みか) */
export function isPersistenceEnabled(): boolean {
  return dataDir() !== null;
}

/** `<dataDir>/<name>.json` を読む。無効/不在は null。 */
export function loadJson<T>(name: string): T | null {
  const dir = dataDir();
  if (!dir) return null;
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (err) {
    // Phase 8.38 (B7): 破損は無言 fresh-start にしない — policy override が
    // 黙って permissive default に戻ると危険なので、必ず起動ログに残す
    // eslint-disable-next-line no-console
    console.warn(
      `[persistence] ${name}.json is corrupt — falling back to defaults`,
      (err as Error).message
    );
    return null;
  }
}

/**
 * `<dataDir>/<name>.json` へ書く。無効時は no-op、失敗は握りつぶす。
 * Phase 8.38 (B7): tmp file + rename の atomic 書込 — 書込中クラッシュで
 * 途中まで書かれた JSON が残らない (rename は同一 FS 内で atomic)。
 */
export function saveJson(name: string, value: unknown): void {
  const dir = dataDir();
  if (!dir) return;
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}.json`);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, file);
  } catch {
    // best-effort: 永続化失敗はサイクル/リクエストを壊さない
  }
}

/**
 * Phase C: `<dataDir>/<name>.json` を消す。無効時 / 不在は no-op、失敗は握りつぶす
 * (portfolio/inputs-store.ts の LRU 掃除用)。
 */
export function deleteJson(name: string): void {
  const dir = dataDir();
  if (!dir) return;
  try {
    unlinkSync(join(dir, `${name}.json`));
  } catch {
    // 不在 / 権限: best-effort
  }
}

/**
 * Phase C: `<prefix>*.json` の一覧 (name は拡張子なし、mtime 付き、古い順)。
 * 無効時 / dir 不在は空配列。書込途中の `.json.tmp` は含めない。
 */
export function listJson(prefix: string): Array<{ name: string; mtimeMs: number }> {
  const dir = dataDir();
  if (!dir || !existsSync(dir)) return [];
  const out: Array<{ name: string; mtimeMs: number }> = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(prefix) || !f.endsWith(".json")) continue;
      try {
        out.push({ name: f.slice(0, -".json".length), mtimeMs: statSync(join(dir, f)).mtimeMs });
      } catch {
        // 列挙と stat の間に消えた
      }
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
}

// ── async 版 (request path から外したい書き込み用。portfolio/inputs-store.ts) ──────────────

/**
 * saveJson の async 版 (tmp file + rename の atomic 書込は同じ)。無効時は no-op、失敗は握りつぶす。
 * 同じ name への並行書込は呼び手が直列化する (tmp file 名が同じため)
 */
export async function saveJsonAsync(name: string, value: unknown): Promise<void> {
  const dir = dataDir();
  if (!dir) return;
  try {
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${name}.json`);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2));
    await rename(tmp, file);
  } catch {
    // best-effort
  }
}

/** `<dataDir>/<name>.json` が在るか (無効時は false) */
export async function jsonExistsAsync(name: string): Promise<boolean> {
  const dir = dataDir();
  if (!dir) return false;
  try {
    await access(join(dir, `${name}.json`));
    return true;
  } catch {
    return false;
  }
}

/** deleteJson の async 版 */
export async function deleteJsonAsync(name: string): Promise<void> {
  const dir = dataDir();
  if (!dir) return;
  try {
    await unlink(join(dir, `${name}.json`));
  } catch {
    // 不在 / 権限: best-effort
  }
}

/** listJson の async 版 (古い順) */
export async function listJsonAsync(
  prefix: string
): Promise<Array<{ name: string; mtimeMs: number }>> {
  const dir = dataDir();
  if (!dir) return [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{ name: string; mtimeMs: number }> = [];
  for (const f of names) {
    if (!f.startsWith(prefix) || !f.endsWith(".json")) continue;
    try {
      out.push({ name: f.slice(0, -".json".length), mtimeMs: (await stat(join(dir, f))).mtimeMs });
    } catch {
      // 列挙と stat の間に消えた
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
}

/**
 * 起動時の書込確認: `dir` を作り (recursive)、probe file を書いて消す。
 * saveJson は失敗を握りつぶすので、volume の mount 漏れ / 権限不足で plan・承認
 * token・監査ログが **黙って** 消える事故を起動時に検出するために使う (index.ts)。
 * 例外は投げない (false を返す)。
 */
export function ensureWritableDataDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.write-probe-${process.pid}-${Date.now()}`);
    writeFileSync(probe, "ok");
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}
