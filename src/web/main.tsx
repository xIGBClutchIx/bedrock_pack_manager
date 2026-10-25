import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@fontsource-variable/figtree";

import { App } from "./App";
import { AppProvider } from "./state/app";
import "./styles/app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>,
);
