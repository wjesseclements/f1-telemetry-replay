import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { loadFixtureReplay } from "./data/fixture.ts";
import { useTransport } from "./store/transport.ts";
import "./index.css";

// Load and validate before the first render: no effect, no extra render pass, and
// the replay is already in the store by the time the canvas mounts.
// Slice 4b wraps this call in the error state; for now a non-conforming fixture
// throws loudly rather than rendering something wrong.
useTransport.getState().setReplay(loadFixtureReplay());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
