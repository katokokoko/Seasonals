// jsdom は canvas / WebGL を持たない。WaterBackground は getContext が null の時
// fallback になる設計なので、その経路を静かに通す。
HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
