/**
 * GET /protocols/skr-staking/state?wallet=&source= (docs/skr-r0-implementation.md §3)
 *
 * - 公開チェーン情報のみ。任意 wallet を読めることは本人認証済みという意味ではない
 * - wallet は base58 検査 (lib/config/chains.ts isSolanaAddress)。不正は 400
 * - `Cache-Control: no-store`。BFF cache / 内部 retry なし
 * - 読取の失敗は HTTP error にせず 200 + data_status (unavailable / unsupported) で返す
 * - source=demo は `SKR_DEMO_FIXTURE=true` の時だけ。live の失敗を demo に差し替えない
 */
import type { FastifyInstance } from "fastify";
import { isSolanaAddress } from "@workspace/lib/config/chains";
import { CooldownSource, isCooldownSource } from "@workspace/lib/types";
import {
  createHeliusSkrRpc,
  InvalidSkrWalletError,
  readSkrStakingState,
  type SkrRpc,
} from "../clients/skr-staking";
import {
  createDemoSkrRpc,
  skrDemoEnabled,
  skrDemoOptionsFromEnv,
  type SkrDemoOptions,
} from "../clients/skr-staking-demo";

export const SKR_STAKING_STATE_PATH = "/protocols/skr-staking/state";

export interface SkrStakingRouteDeps {
  liveRpc?: () => SkrRpc;
  /** demo の設定 (未指定なら env から。anchor は登録時に 1 回だけ決める) */
  demo?: SkrDemoOptions;
  demoEnabled?: () => boolean;
  now?: () => Date;
}

export async function registerSkrStakingRoutes(
  app: FastifyInstance,
  deps: SkrStakingRouteDeps = {}
): Promise<void> {
  const liveRpc = deps.liveRpc ?? createHeliusSkrRpc;
  const demoEnabled = deps.demoEnabled ?? (() => skrDemoEnabled());
  const demo = deps.demo ?? skrDemoOptionsFromEnv();

  app.get<{ Querystring: { wallet?: string; source?: string } }>(
    SKR_STAKING_STATE_PATH,
    async (req, reply) => {
      reply.header("Cache-Control", "no-store");

      const wallet = req.query?.wallet?.trim();
      if (!wallet) {
        reply.code(400);
        return { error: "wallet_required" };
      }
      if (!isSolanaAddress(wallet)) {
        reply.code(400);
        return { error: "invalid_wallet_address", wallet };
      }
      const source = req.query?.source ?? CooldownSource.Live;
      if (!isCooldownSource(source)) {
        reply.code(400);
        return { error: "invalid_source" };
      }
      if (source === CooldownSource.Demo && !demoEnabled()) {
        reply.code(400);
        return { error: "demo_source_disabled" };
      }

      try {
        const rpc = source === CooldownSource.Demo ? createDemoSkrRpc(wallet, demo) : liveRpc();
        return await readSkrStakingState(wallet, {
          source,
          rpc,
          now: deps.now,
          onReject: (status, reason) => req.log.warn({ status, reason }, "skr staking read rejected"),
        });
      } catch (err) {
        if (err instanceof InvalidSkrWalletError) {
          reply.code(400);
          return { error: "invalid_wallet_address", wallet };
        }
        throw err;
      }
    }
  );
}
