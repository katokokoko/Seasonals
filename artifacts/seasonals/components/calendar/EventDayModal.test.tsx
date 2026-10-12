/**
 * EventDayModal — visible boolean → BottomSheetModal.present() / dismiss() の橋渡し
 *
 * @gorhom/bottom-sheet v5 は未 present の sheet に dismiss() を呼ぶと内部 status が
 * DISMISSING に固まり、以後の present() で sheet が出なくなる (v4 では no-op だった)。
 * mount 時 (visible=false) と、pan-down / backdrop で閉じた後の visible=false で
 * dismiss() を呼ばないことを回帰 test で固定する。
 *
 * gorhom の実物は jest で sheet の status 遷移まで再現できないため、このファイル内で
 * BottomSheetModal を ref (present / dismiss) と onChange だけの mock に置き換え、
 * EventDayModal が「いつ present / dismiss を呼ぶか」を検証する。
 */
import React from "react";
import { act, render } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { EventDayModal } from "./EventDayModal";

const mockPresent = jest.fn();
const mockDismiss = jest.fn();
let mockOnChange: ((index: number) => void) | undefined;

jest.mock("@gorhom/bottom-sheet", () => {
  const React = require("react");
  const { View, TextInput } = require("react-native");
  const BottomSheetModal = React.forwardRef(
    (
      props: { children?: React.ReactNode; onChange?: (index: number) => void },
      ref: React.Ref<unknown>
    ) => {
      React.useImperativeHandle(ref, () => ({
        present: mockPresent,
        dismiss: mockDismiss,
      }));
      mockOnChange = props.onChange;
      return React.createElement(View, null, props.children);
    }
  );
  const passThrough = ({ children }: { children?: React.ReactNode }) =>
    React.createElement(View, null, children);
  return {
    __esModule: true,
    BottomSheetModal,
    BottomSheetScrollView: passThrough,
    BottomSheetView: passThrough,
    BottomSheetBackdrop: () => null,
    BottomSheetTextInput: TextInput,
  };
});

const METRICS = {
  frame: { x: 0, y: 0, width: 400, height: 800 },
  insets: { top: 24, left: 0, right: 0, bottom: 16 },
};

const DAY = new Date(2026, 9, 8);

function ui(visible: boolean, onClose: () => void = () => {}) {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <EventDayModal
        visible={visible}
        day={DAY}
        events={[]}
        onClose={onClose}
        onActionPress={() => {}}
        testID="day"
      />
    </SafeAreaProvider>
  );
}

beforeEach(() => {
  mockPresent.mockClear();
  mockDismiss.mockClear();
  mockOnChange = undefined;
});

describe("EventDayModal present / dismiss bridge", () => {
  it("visible=false で mount しても dismiss() を呼ばない", () => {
    render(ui(false));
    expect(mockDismiss).not.toHaveBeenCalled();
    expect(mockPresent).not.toHaveBeenCalled();
  });

  it("visible=true になると present() を 1 回呼ぶ", () => {
    const { rerender } = render(ui(false));
    rerender(ui(true));
    expect(mockPresent).toHaveBeenCalledTimes(1);
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it("visible が true → false になると dismiss() を 1 回呼ぶ", () => {
    const { rerender } = render(ui(false));
    rerender(ui(true));
    rerender(ui(false));
    expect(mockDismiss).toHaveBeenCalledTimes(1);
  });

  it("sheet 側で閉じた (onChange(-1)) 後の visible=false では dismiss() を呼ばない", () => {
    const onClose = jest.fn();
    const { rerender } = render(ui(false, onClose));
    rerender(ui(true, onClose));
    expect(mockPresent).toHaveBeenCalledTimes(1);

    // pan-down / backdrop で閉じた
    act(() => {
      mockOnChange?.(-1);
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    // 親が onClose を受けて visible=false にする
    rerender(ui(false, onClose));
    expect(mockDismiss).not.toHaveBeenCalled();

    // 再度開けば present() される
    rerender(ui(true, onClose));
    expect(mockPresent).toHaveBeenCalledTimes(2);
  });
});
