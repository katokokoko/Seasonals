/**
 * Jest setup — Mobile (artifacts/seasonals)
 *
 * - expo-haptics の global mock (テスト環境で物理デバイス API は不要)
 * - react-native-svg の global mock (native side で props がカラー変換 / `none`→null
 *   される問題を回避するため、View ベースの pass-through に置き換える)
 * - 個別テストで上書きしたい場合は test ファイル側で jest.mock() を再宣言する
 */

jest.mock("expo-haptics", () => ({
  selectionAsync: jest.fn().mockResolvedValue(undefined),
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  impactAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
}));

jest.mock("expo-notifications", () => {
  const listeners = new Set();
  return {
    __esModule: true,
    setNotificationHandler: jest.fn(),
    getPermissionsAsync: jest.fn(async () => ({ status: "granted" })),
    requestPermissionsAsync: jest.fn(async () => ({ status: "granted" })),
    getExpoPushTokenAsync: jest.fn(async () => ({
      data: "ExponentPushToken[mock-token]",
    })),
    addNotificationResponseReceivedListener: jest.fn((handler) => {
      listeners.add(handler);
      return {
        remove: () => {
          listeners.delete(handler);
        },
      };
    }),
    getLastNotificationResponseAsync: jest.fn(async () => null),
    scheduleNotificationAsync: jest.fn(async () => "notification_id_mock"),
    __triggerResponse: (response) => {
      listeners.forEach((h) => h(response));
    },
  };
});

jest.mock("@react-native-async-storage/async-storage", () => {
  const memory = new Map();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (key) => (memory.has(key) ? memory.get(key) : null)),
      setItem: jest.fn(async (key, value) => {
        memory.set(key, value);
      }),
      removeItem: jest.fn(async (key) => {
        memory.delete(key);
      }),
      clear: jest.fn(async () => memory.clear()),
    },
  };
});

jest.mock("expo-secure-store", () => {
  const memory = new Map();
  return {
    getItemAsync: jest.fn(async (key) =>
      memory.has(key) ? memory.get(key) : null
    ),
    setItemAsync: jest.fn(async (key, value) => {
      memory.set(key, value);
    }),
    deleteItemAsync: jest.fn(async (key) => {
      memory.delete(key);
    }),
    __resetSecureStoreMemory: () => memory.clear(),
  };
});

// react-native-get-random-values は side-effect import なので空 mock で十分
jest.mock("react-native-get-random-values", () => ({}));

jest.mock("react-native-svg", () => {
  const React = require("react");
  const { View } = require("react-native");
  const mock = (name) => {
    const Comp = React.forwardRef((props, ref) =>
      React.createElement(View, { ...props, ref })
    );
    Comp.displayName = name;
    return Comp;
  };
  const Svg = mock("Svg");
  return {
    __esModule: true,
    default: Svg,
    Svg,
    Circle: mock("Circle"),
    Path: mock("Path"),
    G: mock("G"),
    Rect: mock("Rect"),
    Line: mock("Line"),
    Polygon: mock("Polygon"),
    Polyline: mock("Polyline"),
    Ellipse: mock("Ellipse"),
    Defs: mock("Defs"),
    LinearGradient: mock("LinearGradient"),
    RadialGradient: mock("RadialGradient"),
    Stop: mock("Stop"),
    Text: mock("SvgText"),
    TSpan: mock("TSpan"),
    Use: mock("Use"),
    Mask: mock("Mask"),
    Pattern: mock("Pattern"),
    Symbol: mock("Symbol"),
    ClipPath: mock("ClipPath"),
    ForeignObject: mock("ForeignObject"),
    Image: mock("SvgImage"),
  };
});

// ── @shopify/react-native-skia (Phase 8.36) ──────────────────────────────────
// 公式 jestSetup は canvaskit-wasm (global.CanvasKit) 前提で重いため、
// react-native-svg と同じ View pass-through 方式の軽量 mock にする。
// 絵は assert しない (GlassLayer のテストは退避ロジックのみ)。
jest.mock("@shopify/react-native-skia", () => {
  const React = require("react");
  const { View } = require("react-native");
  const mock = (name) => {
    const C = ({ children, ...props }) =>
      React.createElement(View, { ...props, testID: props.testID ?? `skia-${name}` }, children);
    C.displayName = name;
    return C;
  };
  const makePath = () => ({
    moveTo: () => undefined,
    lineTo: () => undefined,
    close: () => undefined,
    addCircle: () => undefined,
    reset: () => undefined,
  });
  return {
    Canvas: mock("Canvas"),
    Group: mock("Group"),
    Path: mock("Path"),
    Rect: mock("Rect"),
    RoundedRect: mock("RoundedRect"),
    Fill: mock("Fill"),
    Shader: mock("Shader"),
    LinearGradient: mock("SkiaLinearGradient"),
    RadialGradient: mock("SkiaRadialGradient"),
    BlurMask: mock("BlurMask"),
    vec: (x, y) => ({ x, y }),
    // 8.81: RuntimeEffect (liquid-shader)。SkSL の compile はできないので
    // truthy な stub を返す — shader の実描画は実機で確認する (confirm.md §A)
    Skia: {
      Path: { Make: makePath },
      RuntimeEffect: { Make: (sksl) => ({ __sksl: sksl }) },
    },
  };
});

// ── expo-sensors (Phase 8.36) ────────────────────────────────────────────────
// Accelerometer (MelonSodaBackground) / DeviceMotion (useTiltRoll)。
// listener は no-op、availability は false (テストでは静的退避側を通す)。
jest.mock("expo-sensors", () => ({
  Accelerometer: {
    setUpdateInterval: jest.fn(),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
  },
  DeviceMotion: {
    isAvailableAsync: jest.fn(async () => false),
    requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
    setUpdateInterval: jest.fn(),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));
