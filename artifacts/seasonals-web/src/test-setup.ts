// jsdom は canvas / WebGL を持たない。WaterBackground は getContext が null の時
// fallback になる設計なので、その経路を静かに通す。
HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];

// react-router の navigation (Navigate / setSearchParams) は `new Request(url, { signal })` を作るが、
// jsdom の AbortSignal は Node (undici) の Request に instance として認められず throw する (Node 25)。
// テストでは abort を使わないので signal だけ落として渡す。
const NodeRequest = globalThis.Request;
globalThis.Request = class extends NodeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (init?.signal) {
      const { signal: _signal, ...rest } = init;
      super(input, rest);
    } else super(input, init);
  }
} as typeof Request;
