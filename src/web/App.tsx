import { useEffect, useState } from "react";

import { TOKEN } from "./api/client";
import { ConfirmHost, ToastHost } from "./components/common";
import { ConnectScreen } from "./components/ConnectScreen";
import { Dashboard } from "./components/Dashboard";
import { useApp } from "./state/app";

export function App() {
  const { state, refresh, watchActive } = useApp();
  const [error, setError] = useState<string | null>(
    TOKEN ? null : "Missing access token. Open the full link printed when the app started.",
  );

  useEffect(() => {
    if (!TOKEN) return;
    refresh().then(
      // A task started before this page loaded (a reload mid-install, another tab): show it and its Cancel button.
      (current) => current.activeJob && void watchActive(),
      (caught: Error) => setError(caught.message),
    );
  }, [refresh, watchActive]);

  if (error) return <div className="boot banner danger">{error}</div>;
  if (!state) return <div className="boot">Loading…</div>;
  return (
    <>
      {state.connected ? <Dashboard /> : <ConnectScreen />}
      <ConfirmHost />
      <ToastHost />
    </>
  );
}
