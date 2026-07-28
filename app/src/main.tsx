import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { bootstrapReplay } from "./data/bootstrap.ts";
import { useTransport } from "./store/transport.ts";
import "./index.css";

// Load and validate before the first render: no effect, no extra render pass, and
// the replay is already in the store by the time the canvas mounts.
//
// `bootstrapReplay` returns a failure rather than throwing one, so `createRoot` is
// always reached and a non-conforming replay renders its own error instead of a
// blank page. Validation is still strict — nothing renders a car from data that did
// not pass the schema.
const boot = bootstrapReplay();
if (boot.replay !== null) {
  useTransport.getState().setReplay(boot.replay);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App bootstrapError={boot.error} />
  </StrictMode>,
);
