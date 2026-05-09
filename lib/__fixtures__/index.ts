/**
 * Seasonals — Test fixtures
 *
 * `lib/types/*` の型に準拠した mock データ。テストおよび UI mock dev で使用。
 *
 * 使い方:
 *
 *   import {
 *     fixtureUnifiedTimeEvents,
 *     fixturePositions,
 *     fixtureAgentPlanPendingUser,
 *   } from "@workspace/lib/__fixtures__";
 *
 * 各 fixture は **immutable** として扱う。テスト内で mutate する場合は
 * 必ず deep clone (`structuredClone(fixture)` 等) してから使うこと。
 */

export * from "./time-events";
export * from "./positions";
export * from "./agent-plans";
export * from "./approval-tokens";
export * from "./user-policies";
export * from "./protocols";
export * from "./wallets";
export * from "./menu-listings";
