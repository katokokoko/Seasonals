/**
 * Push notifications service — 仕様書 §8.7 / §10 task #7
 *
 * Mobile が Agent からの approval 要求を受け取る経路を抽象化する。
 *
 * 役割:
 *   1. Expo Push Token の取得 (本番では BFF に登録、§5 で endpoint 接続)
 *   2. foreground / background での通知表示制御 (Notifications.setNotificationHandler)
 *   3. 通知 tap → deep link payload (plan_id / token_id) を取り出す listener
 *   4. dev 用: fixture AgentPlan / ApprovalToken から local notification を発射
 *
 * 規約:
 *   - 通知 payload には **secret を含めない**。plan_id / token_id 等の参照のみ。
 *     詳細は MCPApprovalPushCard が `useAgentPlan` / `useApprovalToken` で別途 fetch。
 *   - notification の data.type === "approval" を契機に MCPApprovalPushCard 経路へ。
 *
 * @see CLAUDE.md §10 task #7 (MCP approval push handler)
 * @see ./../components/action/MCPApprovalPushCard.tsx
 */

import * as Notifications from "expo-notifications";
import type { Subscription } from "expo-notifications";

import {
  fixtureAgentPlanPendingUser,
  fixtureApprovalTokenActive,
} from "@workspace/lib/__fixtures__";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** notification.data に乗せる approval payload (BFF 側から送る形と同じ shape) */
export interface ApprovalPushPayload {
  /** discriminator — "approval" のときだけ MCPApprovalPushCard 経路 */
  type: "approval";
  /** AgentPlan の plan_id (本体は BFF から fetch) */
  plan_id: string;
  /** ApprovalToken の token_id (本体は BFF から fetch) */
  token_id: string;
  /** 短縮表示用の hint (受信時にすぐ見せる用、機微情報は含めない) */
  protocol?: string;
  action_type?: string;
}

/** ApprovalPushPayload かを runtime check */
export function isApprovalPushPayload(
  data: unknown
): data is ApprovalPushPayload {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.type === "approval" &&
    typeof d.plan_id === "string" &&
    typeof d.token_id === "string"
  );
}

/**
 * Phase 8.29: 自律実行で「資金が動いた」通知の payload (BFF autonomous が送る形)。
 * approval と違い事前承認を経ない事後通知。機微情報は含めず参照のみ。
 */
export interface ExecutionPushPayload {
  type: "execution";
  record_id: string;
  plan_id: string | null;
  protocol: string | null;
  action_type: string;
  amount_usd8: string;
  tx_signature: string | null;
  status: "executed" | "failed";
}

/** ExecutionPushPayload かを runtime check */
export function isExecutionPushPayload(
  data: unknown
): data is ExecutionPushPayload {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return d.type === "execution" && typeof d.record_id === "string";
}

/** Seasonals の push payload union (approval | execution)。 */
export type SeasonalsPushPayload = ApprovalPushPayload | ExecutionPushPayload;

// ─────────────────────────────────────────────────────────────────────────────
// Handler 設定 — foreground でも banner / sound を出す
// ─────────────────────────────────────────────────────────────────────────────

let handlerInstalled = false;

/**
 * App 起動時に 1 回だけ呼ぶ。foreground にいるときも notification を表示する設定。
 */
export function setupNotificationHandler(): void {
  if (handlerInstalled) return;
  handlerInstalled = true;

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      // SDK 54 (expo-notifications 0.32): shouldShowAlert が banner/list に分割された
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Expo Push Token 取得
// ─────────────────────────────────────────────────────────────────────────────

export interface PushTokenResult {
  /** Expo Push Token (ExponentPushToken[xxx]) — BFF に登録する文字列 */
  token: string;
  /** plain device push token (FCM/APNs) — ほぼ debug 用 */
  devicePushToken?: string;
}

/**
 * 通知 permission を request し、Expo Push Token を取得。
 *
 * NOTE: Expo Push Token を実 push に使うには projectId が必要。EAS Build / app.json
 * の `extra.eas.projectId` から自動解決される。MVP の dev 段階では projectId 未設定
 * で取得できる token は staging-only。
 */
export async function getPushToken(): Promise<PushTokenResult> {
  const perm = await Notifications.getPermissionsAsync();
  let granted = perm.status === "granted";
  if (!granted) {
    const req = await Notifications.requestPermissionsAsync();
    granted = req.status === "granted";
  }
  if (!granted) {
    throw new Error("notification_permission_denied");
  }

  const expoToken = await Notifications.getExpoPushTokenAsync();
  return { token: expoToken.data };
}

// ─────────────────────────────────────────────────────────────────────────────
// 通知 tap listener
// ─────────────────────────────────────────────────────────────────────────────

export type ApprovalResponseHandler = (payload: ApprovalPushPayload) => void;

/**
 * 通知を tap して app が起動 / foreground 復帰した際の listener。
 * unsubscribe するための Subscription を返す。
 */
export function addApprovalResponseListener(
  handler: ApprovalResponseHandler
): Subscription {
  return Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data;
    if (isApprovalPushPayload(data)) {
      handler(data);
    }
  });
}

/**
 * cold start 時 (app が完全に閉じている状態で notification tap で起動) の取得。
 * `useEffect` 内で 1 回呼んで、payload があれば deep link routing する。
 */
export async function getInitialApprovalResponse(): Promise<
  ApprovalPushPayload | null
> {
  const last = await Notifications.getLastNotificationResponseAsync();
  if (!last) return null;
  const data = last.notification.request.content.data;
  return isApprovalPushPayload(data) ? data : null;
}

/**
 * Phase 8.29: 自律実行の「資金が動いた」通知 tap を受ける (v1 は log のみ、
 * 専用画面は後続)。ExecutionPushPayload を受け取る generic listener。
 */
export function addExecutionResponseListener(
  handler: (payload: ExecutionPushPayload) => void
): Subscription {
  return Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data;
    if (isExecutionPushPayload(data)) {
      handler(data);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// dev helper — local notification (BFF 接続前の動作確認用)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * fixture AgentPlan + ApprovalToken を payload に local notification を即発射。
 * 開発用なので __DEV__ の場合のみ呼ぶこと。
 */
export async function scheduleLocalApprovalNotification(opts: {
  plan_id?: string;
  token_id?: string;
  protocol?: string;
  action_type?: string;
  title?: string;
  body?: string;
  delaySeconds?: number;
}): Promise<string> {
  const plan_id = opts.plan_id ?? fixtureAgentPlanPendingUser.plan_id;
  const token_id = opts.token_id ?? fixtureApprovalTokenActive.token_id;
  const protocol =
    opts.protocol ??
    fixtureAgentPlanPendingUser.selected_action?.protocol ??
    "kamino";
  const action_type =
    opts.action_type ??
    fixtureAgentPlanPendingUser.selected_action?.action_type ??
    "re_deposit_include_yield";

  const payload: ApprovalPushPayload = {
    type: "approval",
    plan_id,
    token_id,
    protocol,
    action_type,
  };

  return await Notifications.scheduleNotificationAsync({
    content: {
      title: opts.title ?? "Agent からの提案",
      body: opts.body ?? `${protocol} ${action_type} の承認待ち`,
      data: payload as unknown as Record<string, unknown>,
    },
    trigger:
      opts.delaySeconds && opts.delaySeconds > 0
        ? { seconds: opts.delaySeconds, channelId: "default" }
        : null, // null = 即時発火
  });
}
