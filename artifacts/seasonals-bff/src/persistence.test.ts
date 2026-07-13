/**
 * persistence — 最小 file-backed 永続化のテスト (Phase 8.30)
 *
 * SEASONALS_DATA_DIR を temp dir に向けて round-trip を検証し、未設定時は
 * no-op (既存テストが hermetic なまま) であることを担保する。policy override /
 * autonomous log が「再起動相当 (reset → load)」で復元されることも確認。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fixtureAutonomousLog } from "@workspace/lib/__fixtures__";

import { isPersistenceEnabled, loadJson, saveJson } from "./persistence";
import {
  _resetPolicyForTest,
  getCurrentPolicy,
  loadPersistedPolicy,
  patchCurrentPolicy,
} from "./policy-store";
import {
  _resetAutonomousForTest,
  listExecutionRecords,
  loadPersistedRecords,
} from "./autonomous";

const savedEnv = process.env.SEASONALS_DATA_DIR;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seasonals-persist-"));
  process.env.SEASONALS_DATA_DIR = dir;
  _resetPolicyForTest();
  _resetAutonomousForTest();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.SEASONALS_DATA_DIR;
  else process.env.SEASONALS_DATA_DIR = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe("persistence module", () => {
  it("saveJson → loadJson round-trip", () => {
    expect(isPersistenceEnabled()).toBe(true);
    saveJson("thing", { a: 1, b: "x" });
    expect(loadJson<{ a: number; b: string }>("thing")).toEqual({
      a: 1,
      b: "x",
    });
  });

  it("SEASONALS_DATA_DIR 未設定なら no-op (書かない・読めない)", () => {
    delete process.env.SEASONALS_DATA_DIR;
    expect(isPersistenceEnabled()).toBe(false);
    saveJson("thing", { a: 1 });
    expect(loadJson("thing")).toBeNull();
  });

  it("不在キーは null (壊れず fresh start)", () => {
    expect(loadJson("never-written")).toBeNull();
  });
});

describe("policy override 永続化", () => {
  it("PATCH → reset → load で override が復元される", () => {
    patchCurrentPolicy({ approval_mode: "auto", max_tx_amount: "5.00000000" });
    // 再起動相当: in-memory を捨てて disk からロード
    _resetPolicyForTest();
    expect(getCurrentPolicy().approval_mode).not.toBe("auto");
    loadPersistedPolicy();
    expect(getCurrentPolicy().approval_mode).toBe("auto");
    expect(getCurrentPolicy().max_tx_amount).toBe("5.00000000");
  });
});

describe("autonomous log 永続化", () => {
  it("保存済みログを reset → load で復元する (newest-first)", () => {
    saveJson("autonomous-log", fixtureAutonomousLog);
    _resetAutonomousForTest();
    expect(listExecutionRecords()).toHaveLength(0);
    loadPersistedRecords();
    // listExecutionRecords は newest-first に reverse する
    const restored = listExecutionRecords();
    expect(restored).toHaveLength(fixtureAutonomousLog.length);
    expect(restored[0]!.record_id).toBe(
      fixtureAutonomousLog[fixtureAutonomousLog.length - 1]!.record_id
    );
  });
});
