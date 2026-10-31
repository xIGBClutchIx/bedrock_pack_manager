import { useEffect, useState } from "react";

import { TOKEN } from "./api/client";
import { ConfirmHost, StaleLinkBanner, ToastHost } from "./components/common";
import { ConnectScreen } from "./components/ConnectScreen";
import { Dashboard } from "./components/Dashboard";
import { useApp } from "./state/app";

export function App() {
  const { state, refresh, watchActive, staleLink } = useApp();
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

  // A page from an earlier launch: every call fails the same way, so say it once and say what to do.
  if (staleLink && !state) return <StaleLinkBanner boot />;
  if (error) return <div className="boot banner danger">{error}</div>;
  if (!state) return <div className="boot">Loading…</div>;
  return (
    <>
      {staleLink && <StaleLinkBanner />}
      {state.connected ? <Dashboard /> : <ConnectScreen />}
      <ConfirmHost />
      <ToastHost />
    </>
  );
}
