import { WaterBackground } from "./background/WaterBackground";

export function App() {
  return (
    <>
      <WaterBackground className="water-canvas" />
      <main className="ui-layer">
        <h1>Seasonals</h1>
      </main>
    </>
  );
}
