/**
 * DropletMarker — テスト
 *
 * §32.2 整合性チェック「8 categories of time」をコードレベルで担保する。
 * `lib/types/enums.ts` の `TIME_EVENT_CATEGORIES` を直接 import して
 * iteration ベースで全カテゴリを網羅。enum 追加時に test も自動的に拡張される。
 *
 * 環境: jest-expo + @testing-library/react-native
 * 依存: react-native-svg は jest-expo の preset で自動 mock される想定。
 *       一部環境では明示的な mock が必要なため fallback を用意。
 */

import React from "react";
import { render, screen } from "@testing-library/react-native";

import { DropletMarker, ALL_DROPLET_SHAPES, type DropletShape } from "./DropletMarker";
import {
  TIME_EVENT_CATEGORIES,
  Urgency,
  URGENCIES,
} from "@workspace/lib/types";
import { COLOR, urgencyColor } from "@workspace/lib/design-system";
import { fixtureUnifiedTimeEvents } from "@workspace/lib/__fixtures__";

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("DropletMarker", () => {
  // ── 静的整合性 (§32.2 「8 categories of time」) ──

  describe("§32.2 整合性チェック", () => {
    it("ALL_DROPLET_SHAPES は TimeEventCategory 8 種 + deposit_history 1 種 = 9 種", () => {
      expect(ALL_DROPLET_SHAPES.length).toBe(9);
      expect(ALL_DROPLET_SHAPES.length).toBe(TIME_EVENT_CATEGORIES.length + 1);
    });

    it("ALL_DROPLET_SHAPES に TIME_EVENT_CATEGORIES の 8 種すべてが含まれる", () => {
      for (const category of TIME_EVENT_CATEGORIES) {
        expect(ALL_DROPLET_SHAPES).toContain(category);
      }
    });

    it("ALL_DROPLET_SHAPES の 9 種目は補助表示の deposit_history", () => {
      expect(ALL_DROPLET_SHAPES).toContain("deposit_history");
    });
  });

  // ── 9 種すべての shape が render error なく描画される ──

  describe("9 種すべての shape を render", () => {
    it.each(ALL_DROPLET_SHAPES)(
      "category='%s' で render error なく描画される",
      (shape) => {
        const { unmount } = render(
          <DropletMarker
            category={shape}
            urgency={Urgency.Info}
            testID={`dm-${shape}`}
          />
        );
        expect(screen.getByTestId(`dm-${shape}`)).toBeTruthy();
        unmount();
      }
    );
  });

  // ── 9 種 × 3 urgency = 27 パターン smoke test ──

  describe("9 種 × 3 urgency の組み合わせ網羅", () => {
    const combinations: Array<[DropletShape, Urgency]> = [];
    for (const shape of ALL_DROPLET_SHAPES) {
      for (const urgency of URGENCIES) {
        combinations.push([shape, urgency]);
      }
    }

    it.each(combinations)(
      "shape=%s urgency=%s で render error なし",
      (shape, urgency) => {
        const { unmount } = render(
          <DropletMarker category={shape} urgency={urgency} testID="dm" />
        );
        expect(screen.getByTestId("dm")).toBeTruthy();
        unmount();
      }
    );
  });

  // ── prop の伝搬 ──

  describe("props 伝搬", () => {
    it("default size は 8px", () => {
      render(
        <DropletMarker category="maturity" urgency={Urgency.Info} testID="dm" />
      );
      const svg = screen.getByTestId("dm");
      expect(svg.props.width).toBe(8);
      expect(svg.props.height).toBe(8);
    });

    it("custom size が svg width / height に反映される", () => {
      render(
        <DropletMarker
          category="epoch"
          urgency={Urgency.Info}
          size={16}
          testID="dm"
        />
      );
      const svg = screen.getByTestId("dm");
      expect(svg.props.width).toBe(16);
      expect(svg.props.height).toBe(16);
    });

    it("default accessibilityLabel は category の日本語名", () => {
      render(
        <DropletMarker
          category="maturity"
          urgency={Urgency.Info}
          testID="dm"
        />
      );
      expect(screen.getByTestId("dm").props.accessibilityLabel).toBe("満期");
    });

    it("custom accessibilityLabel で default を上書きできる", () => {
      render(
        <DropletMarker
          category="maturity"
          urgency={Urgency.Info}
          accessibilityLabel="Custom label for testing"
          testID="dm"
        />
      );
      expect(screen.getByTestId("dm").props.accessibilityLabel).toBe(
        "Custom label for testing"
      );
    });

    it("accessibilityRole='image' が常に付く", () => {
      render(
        <DropletMarker
          category="health"
          urgency={Urgency.Critical}
          testID="dm"
        />
      );
      expect(screen.getByTestId("dm").props.accessibilityRole).toBe("image");
    });
  });

  // ── 各 shape の testID 検証 (どの shape が render されたか確実に検知) ──

  describe("shape 種別の検証 (testID 経由)", () => {
    it.each([
      ["maturity", "droplet-shape-maturity"],
      ["lockup_end", "droplet-shape-lockup-end"],
      ["epoch", "droplet-shape-epoch"],
      ["claim", "droplet-shape-claim"],
      ["health", "droplet-shape-health"],
      ["vesting_cliff", "droplet-shape-vesting-cliff"],
      ["forecast_marker", "droplet-shape-forecast-marker"],
      ["deposit_history", "droplet-shape-deposit-history"],
    ] as const)(
      "category=%s で testID=%s が描画される",
      (shape, expectedTestId) => {
        render(
          <DropletMarker
            category={shape as DropletShape}
            urgency={Urgency.Info}
            testID="dm"
          />
        );
        expect(screen.getByTestId(expectedTestId)).toBeTruthy();
      }
    );

    it("vote_deadline は pole + flag の 2 要素から成る", () => {
      render(
        <DropletMarker
          category="vote_deadline"
          urgency={Urgency.Watch}
          testID="dm"
        />
      );
      expect(screen.getByTestId("droplet-shape-vote-deadline-pole")).toBeTruthy();
      expect(screen.getByTestId("droplet-shape-vote-deadline-flag")).toBeTruthy();
    });

    it("lockup_end は maturity と異なる testID で区別される (§5.3)", () => {
      const { rerender } = render(
        <DropletMarker
          category="maturity"
          urgency={Urgency.Info}
          testID="dm"
        />
      );
      expect(screen.queryByTestId("droplet-shape-maturity")).toBeTruthy();
      expect(screen.queryByTestId("droplet-shape-lockup-end")).toBeNull();

      rerender(
        <DropletMarker
          category="lockup_end"
          urgency={Urgency.Info}
          testID="dm"
        />
      );
      expect(screen.queryByTestId("droplet-shape-maturity")).toBeNull();
      expect(screen.queryByTestId("droplet-shape-lockup-end")).toBeTruthy();
    });
  });

  // ── color 決定ロジック ──

  describe("color 決定", () => {
    it("color prop が urgency-derived color を override する", () => {
      const customColor = "#FF00FF";
      render(
        <DropletMarker
          category="health"
          urgency={Urgency.Info} // info の色は使われないはず
          color={customColor}
          testID="dm"
        />
      );
      const path = screen.getByTestId("droplet-shape-health");
      expect(path.props.fill).toBe(customColor);
    });

    it("color prop なしの場合 urgency=info → urgencyColor(info)", () => {
      render(
        <DropletMarker
          category="epoch"
          urgency={Urgency.Info}
          testID="dm"
        />
      );
      const circle = screen.getByTestId("droplet-shape-epoch");
      expect(circle.props.fill).toBe(urgencyColor(Urgency.Info));
    });

    it("urgency=critical → cherryDark 系の色 (non-health)", () => {
      // health は urgency に関わらず caramel に固定するため maturity で検証
      render(
        <DropletMarker
          category="maturity"
          urgency={Urgency.Critical}
          testID="dm"
        />
      );
      const path = screen.getByTestId("droplet-shape-maturity");
      expect(path.props.fill).toBe(urgencyColor(Urgency.Critical));
      expect(path.props.fill).toBe(COLOR.cherryDark);
    });

    it("category=health は urgency に関わらず caramel (subtle warning)", () => {
      // prototype の "穏やかな warning indicator" を担保: critical でも red 化しない
      render(
        <DropletMarker
          category="health"
          urgency={Urgency.Critical}
          testID="dm"
        />
      );
      const rect = screen.getByTestId("droplet-shape-health");
      expect(rect.props.fill).toBe(COLOR.caramel);
    });

    it("urgency=watch → caramel 系の色", () => {
      render(
        <DropletMarker
          category="claim"
          urgency={Urgency.Watch}
          testID="dm"
        />
      );
      const path = screen.getByTestId("droplet-shape-claim");
      expect(path.props.fill).toBe(urgencyColor(Urgency.Watch));
      expect(path.props.fill).toBe(COLOR.caramel);
    });
  });

  // ── outlined vs filled の区別 (lockup_end / forecast_marker) ──

  describe("outlined / dashed shapes", () => {
    it("lockup_end は fill='none' + stroke で outlined", () => {
      render(
        <DropletMarker
          category="lockup_end"
          urgency={Urgency.Info}
          testID="dm"
        />
      );
      const path = screen.getByTestId("droplet-shape-lockup-end");
      expect(path.props.fill).toBe("none");
      expect(path.props.stroke).toBe(urgencyColor(Urgency.Info));
    });

    it("forecast_marker は dashed circle (strokeDasharray)", () => {
      render(
        <DropletMarker
          category="forecast_marker"
          urgency={Urgency.Info}
          testID="dm"
        />
      );
      const circle = screen.getByTestId("droplet-shape-forecast-marker");
      expect(circle.props.fill).toBe("none");
      expect(circle.props.strokeDasharray).toBe("2 2");
    });
  });

  // ── lib との 4 層 integration (lib/types + lib/__fixtures__ + lib/design-system + Mobile) ──

  describe("lib fixture との統合", () => {
    it("fixtureUnifiedTimeEvents の全 8 イベントから DropletMarker を render できる", () => {
      // §32.2「8 categories of time」の end-to-end 担保:
      // - lib/types/enums.ts: TimeEventCategory enum (8 種)
      // - lib/__fixtures__/time-events.ts: 8 種すべての fixture
      // - lib/design-system.ts: urgencyColor mapping
      // - artifacts/seasonals: DropletMarker が category + urgency を受けて render
      // この 4 層を 1 テストで通すことで、新しい category 追加時に必ずどこかで
      // type / runtime error が出るようにする
      expect(fixtureUnifiedTimeEvents.length).toBe(8);

      for (const event of fixtureUnifiedTimeEvents) {
        const { unmount } = render(
          <DropletMarker
            category={event.category}
            urgency={event.urgency}
            testID={`dm-${event.id}`}
          />
        );
        expect(screen.getByTestId(`dm-${event.id}`)).toBeTruthy();
        unmount();
      }
    });
  });
});
