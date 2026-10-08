/**
 * SKR cooldown の端末確認通知 (docs/skr-r0-implementation.md §5)
 *
 * - 文言は「SKRの引き出し状況を確認してください」。ready や金額を断定しない
 * - fresh 取得時にだけ予約・置換し、同 schedule は 1 件。OS notification ID と予定キーだけを AsyncStorage に保存
 * - 正常な pending=0、wallet / source / cluster 切替、切断で旧予約を取消す。起動時は OS 予約一覧と照合する
 * - 過去の予定を初めて検出した場合に遡って通知しない。permission 拒否でも Calendar は使える
 * - payload は type / schema_version / scope / event_id / schedule_revision のみ (金額・ready・URL・plan・token なし)
 * - tap は scope を照合して BFF を再取得するだけ (署名・wallet 操作はしない)。cold start と warm は同じ handler
 */
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import type { Subscription } from "expo-notifications";

import type { CooldownFreshness } from "@workspace/lib/derive/cooldown-client";
import {
  cooldownScheduleKey,
  cooldownScopeKey,
  type CooldownScopeIdentity,
} from "@workspace/lib/derive/cooldown-position";
import {
  COOLDOWN_SCHEMA_VERSION,
  CooldownDataStatus,
  isCooldownReminderPayload,
  type CooldownEventDTO,
  type CooldownReminderPayload,
  type CooldownStateResponse,
} from "@workspace/lib/types";

export const COOLDOWN_REMINDER_STORE_KEY = "seasonals.cooldownReminder.v1";
export const COOLDOWN_CHANNEL_ID = "cooldown";
export const COOLDOWN_REMINDER_TITLE = "SKR staking";
/** §5 の文言 (ready・金額を断定しない) */
export const COOLDOWN_REMINDER_BODY = "SKRの引き出し状況を確認してください";

interface StoredReminder {
  notificationId: string;
  scopeKey: string;
  scheduleKey: string;
}

async function readStored(): Promise<StoredReminder | null> {
  try {
    const raw = await AsyncStorage.getItem(COOLDOWN_REMINDER_STORE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredReminder>;
    if (typeof v.notificationId === "string" && typeof v.scopeKey === "string" && typeof v.scheduleKey === "string") {
      return v as StoredReminder;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeStored(v: StoredReminder | null): Promise<void> {
  if (v === null) await AsyncStorage.removeItem(COOLDOWN_REMINDER_STORE_KEY);
  else await AsyncStorage.setItem(COOLDOWN_REMINDER_STORE_KEY, JSON.stringify(v));
}

async function cancelStored(stored: StoredReminder | null): Promise<void> {
  if (!stored) return;
  await Notifications.cancelScheduledNotificationAsync(stored.notificationId).catch(() => undefined);
  await writeStored(null);
}

export function buildCooldownReminderPayload(
  state: CooldownStateResponse,
  e: CooldownEventDTO
): CooldownReminderPayload {
  return {
    type: "cooldown_reminder",
    schema_version: COOLDOWN_SCHEMA_VERSION,
    source: state.source,
    cluster: state.cluster,
    wallet_address: state.wallet_address,
    protocol_id: state.protocol_id,
    position_account: state.position_account,
    event_id: e.event.id,
    schedule_revision: e.schedule_revision,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// channel / permission
// ─────────────────────────────────────────────────────────────────────────────

let channelReady: Promise<void> | null = null;

/** Android の通知 channel (起動時と予約前に呼ぶ。冪等) */
export function ensureCooldownNotificationChannel(): Promise<void> {
  if (Platform.OS !== "android") return Promise.resolve();
  if (!channelReady) {
    channelReady = Notifications.setNotificationChannelAsync(COOLDOWN_CHANNEL_ID, {
      name: "SKR staking",
      importance: Notifications.AndroidImportance.DEFAULT,
    })
      .then(() => undefined)
      .catch(() => {
        channelReady = null;
      });
  }
  return channelReady;
}

let permissionAsked = false;

async function canNotify(): Promise<boolean> {
  const perm = await Notifications.getPermissionsAsync();
  if (perm.status === "granted") return true;
  if (permissionAsked) return false; // poll ごとに尋ねない
  permissionAsked = true;
  const req = await Notifications.requestPermissionsAsync();
  return req.status === "granted";
}

// ─────────────────────────────────────────────────────────────────────────────
// 予約の同期
// ─────────────────────────────────────────────────────────────────────────────

export interface CooldownReminderSyncInput {
  /** null = 切断 (直前まで接続していた) */
  scope: CooldownScopeIdentity | null;
  state: CooldownStateResponse | undefined;
  freshness: CooldownFreshness;
  nowMs: number;
}

export type CooldownReminderSyncOutcome =
  | "scheduled"
  | "kept"
  | "cancelled"
  | "not_fresh"
  | "past"
  | "permission_denied"
  | "noop";

async function doSync(input: CooldownReminderSyncInput): Promise<CooldownReminderSyncOutcome> {
  const stored = await readStored();

  // 切断: 旧予約を取消す
  if (input.scope === null) {
    if (!stored) return "noop";
    await cancelStored(stored);
    return "cancelled";
  }

  // wallet / source / cluster 切替: 鮮度に関係なく旧 scope の予約を取消す
  const scopeKey = cooldownScopeKey(input.scope);
  let current = stored;
  let cancelled = false;
  if (current && current.scopeKey !== scopeKey) {
    await cancelStored(current);
    current = null;
    cancelled = true;
  }

  // fresh 以外 (loading / stale / unavailable / unsupported) は予約を変えない (取消済みと解釈しない)
  const state = input.state;
  if (
    input.freshness !== "fresh" ||
    !state ||
    state.data_status !== CooldownDataStatus.Fresh ||
    cooldownScopeKey(state) !== scopeKey
  ) {
    return cancelled ? "cancelled" : "not_fresh";
  }

  // 正常な pending = 0 (event 0 件): 取消
  const e = state.events[0];
  if (!e) {
    if (!current) return cancelled ? "cancelled" : "noop";
    await cancelStored(current);
    return "cancelled";
  }

  const scheduleKey = cooldownScheduleKey(input.scope, e.event.id, e.schedule_revision);
  if (current && current.scheduleKey === scheduleKey) return "kept";

  // 予定が変わった (追加解除 / cooldown 変更): 旧予約を取消してから新しい 1 件
  if (current) {
    await cancelStored(current);
    cancelled = true;
  }
  const triggerMs = Date.parse(e.event.triggerAt);
  if (!Number.isFinite(triggerMs) || triggerMs <= input.nowMs) {
    return cancelled ? "cancelled" : "past"; // 遡って発火しない
  }
  if (!(await canNotify())) return "permission_denied";
  await ensureCooldownNotificationChannel();

  const payload = buildCooldownReminderPayload(state, e);
  const notificationId = await Notifications.scheduleNotificationAsync({
    content: {
      title: COOLDOWN_REMINDER_TITLE,
      body: COOLDOWN_REMINDER_BODY,
      data: payload as unknown as Record<string, unknown>,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: new Date(triggerMs),
      channelId: COOLDOWN_CHANNEL_ID,
    },
  });
  await writeStored({ notificationId, scopeKey, scheduleKey });
  return "scheduled";
}

let chain: Promise<unknown> = Promise.resolve();

/** 直列化して実行する (poll / 再描画が重なっても二重予約しない) */
export function syncCooldownReminder(
  input: CooldownReminderSyncInput
): Promise<CooldownReminderSyncOutcome> {
  const run = chain.then(() => doSync(input));
  chain = run.catch(() => undefined);
  return run;
}

/** 起動時: OS の予約一覧と保存値を照合し、孤児を取消す */
export async function reconcileCooldownRemindersOnStartup(): Promise<void> {
  const stored = await readStored();
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  let storedAlive = false;
  for (const n of scheduled) {
    const data = n.content.data as unknown;
    const isCooldown =
      typeof data === "object" && data !== null && (data as { type?: unknown }).type === "cooldown_reminder";
    if (!isCooldown) continue;
    if (stored && n.identifier === stored.notificationId) {
      storedAlive = true;
    } else {
      await Notifications.cancelScheduledNotificationAsync(n.identifier).catch(() => undefined);
    }
  }
  // 発火済み / OS が消した予約: 保存値も消す (次の fresh read で必要なら予約し直す)
  if (stored && !storedAlive) await writeStored(null);
}

// ─────────────────────────────────────────────────────────────────────────────
// 表示 / tap
// ─────────────────────────────────────────────────────────────────────────────

let activeScope: CooldownScopeIdentity | null = null;

/** HomeScreen が現在の scope を知らせる (foreground 表示の判定用) */
export function setActiveCooldownScope(scope: CooldownScopeIdentity | null): void {
  activeScope = scope;
}

function sameScope(p: CooldownReminderPayload, scope: CooldownScopeIdentity | null): boolean {
  return (
    scope !== null &&
    p.source === scope.source &&
    p.cluster === scope.cluster &&
    p.wallet_address === scope.wallet_address
  );
}

/**
 * foreground で通知を出すか。cooldown 以外の通知は従来どおり true。
 * 形の不正な cooldown 通知・別 wallet / source / cluster の cooldown 通知は出さない。
 */
export function shouldPresentNotificationData(data: unknown): boolean {
  const isCooldownType =
    typeof data === "object" && data !== null && (data as { type?: unknown }).type === "cooldown_reminder";
  if (!isCooldownType) return true;
  return isCooldownReminderPayload(data) && sameScope(data, activeScope);
}

/** 通知 tap (warm)。cooldown payload として正しいものだけ渡す */
export function addCooldownReminderResponseListener(
  handler: (payload: CooldownReminderPayload) => void
): Subscription {
  return Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data;
    if (isCooldownReminderPayload(data)) handler(data);
  });
}

/** 通知 tap (cold start) */
export async function getInitialCooldownReminderResponse(): Promise<CooldownReminderPayload | null> {
  const last = await Notifications.getLastNotificationResponseAsync();
  if (!last) return null;
  const data = last.notification.request.content.data;
  return isCooldownReminderPayload(data) ? data : null;
}

type TapListener = (payload: CooldownReminderPayload) => void;
const tapListeners = new Set<TapListener>();
let pendingTaps: CooldownReminderPayload[] = [];

/** _layout (cold start / warm) → HomeScreen への受け渡し。HomeScreen 未 mount なら mount まで保持 */
export function deliverCooldownReminderTap(payload: CooldownReminderPayload): void {
  if (tapListeners.size === 0) {
    pendingTaps.push(payload);
    return;
  }
  tapListeners.forEach((l) => l(payload));
}

export function onCooldownReminderTap(listener: TapListener): () => void {
  tapListeners.add(listener);
  const queued = pendingTaps;
  pendingTaps = [];
  queued.forEach((p) => listener(p));
  return () => {
    tapListeners.delete(listener);
  };
}

/**
 * tap の処理: 現在の scope と一致すれば BFF を再取得する (古い予定の tap でも最新 read で取消・延期を解決)。
 * 一致しなければ何もしない。署名・wallet 操作はしない。
 */
export function handleCooldownReminderTap(
  payload: CooldownReminderPayload,
  scope: CooldownScopeIdentity | null,
  refetch: () => Promise<unknown>
): "refetched" | "ignored" {
  if (!sameScope(payload, scope)) return "ignored";
  void refetch();
  return "refetched";
}

/** test 用: module 状態を初期化 */
export function __resetCooldownReminderStateForTest(): void {
  channelReady = null;
  permissionAsked = false;
  activeScope = null;
  pendingTaps = [];
  tapListeners.clear();
  chain = Promise.resolve();
}
