import { render, screen } from "@testing-library/react";
import { App } from "./App";

test("renders", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "Seasonals" })).toBeTruthy();
});
