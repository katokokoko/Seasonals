import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { injectTokens } from "./styles/tokens";
import "./styles/base.css";

injectTokens();

const el = document.getElementById("root");
if (!el) throw new Error("#root missing");
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
