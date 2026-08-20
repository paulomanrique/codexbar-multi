import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DashboardSnapshotDTO } from "@codexbar/contracts";

import { createLocalization } from "./localization.ts";
import "./styles.css";

function App() {
  const localization = useMemo(() => createLocalization("system", navigator.languages), []);
  const [snapshot, setSnapshot] = useState<DashboardSnapshotDTO>();
  const [error, setError] = useState<string>();
  const [t3Status, setT3Status] = useState<"idle" | "waiting" | "connected">("idle");
  useEffect(() => {
    document.documentElement.lang = localization.locale;
    document.documentElement.dir = localization.direction;
    return () => {
      document.documentElement.lang = "en";
      document.documentElement.dir = "ltr";
    };
  }, [localization]);

  useEffect(() => {
    window.codexbar
      .getOverview()
      .then(setSnapshot, (cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, []);

  return (
    <main>
      <header>
        <div>
          <small>{localization.t("usageOverview")}</small>
          <h1>CodexBar Multi</h1>
        </div>
        <span className="platform">{localization.t("platform")}</span>
      </header>
      {error === undefined ? null : <p className="error">{error}</p>}
      <div className="login-actions">
        <button
          disabled={t3Status === "waiting"}
          onClick={() => {
            setT3Status("waiting");
            window.codexbar.startLogin({ provider: "t3chat", accountId: "default" }).then(
              (result) => setT3Status(result.status === "connected" ? "connected" : "idle"),
              (cause: unknown) => {
                setError(cause instanceof Error ? cause.message : String(cause));
                setT3Status("idle");
              },
            );
          }}
        >
          {t3Status === "waiting"
            ? localization.t("loginWaiting")
            : t3Status === "connected"
              ? localization.t("loginConnected")
              : localization.t("loginStart")}
        </button>
        {t3Status === "connected" ? (
          <button
            className="secondary"
            onClick={() => {
              void window.codexbar
                .logout({ provider: "t3chat", accountId: "default" })
                .then(() => setT3Status("idle"));
            }}
          >
            {localization.t("logout")}
          </button>
        ) : null}
      </div>
      {snapshot === undefined ? (
        <p className="muted">{localization.t("loadingProviders")}</p>
      ) : (
        <>
          <p className="muted">
            {localization.providerSummary(
              snapshot.providers.filter((provider) => provider.implementationStatus === "partial")
                .length,
              snapshot.providers.length,
            )}
          </p>
          <section>
            {snapshot.providers.map((provider) => (
              <article key={provider.id}>
                <div className="monogram">{provider.name.slice(0, 2).toUpperCase()}</div>
                <div>
                  <strong>{provider.name}</strong>
                  <small>
                    {provider.implementationStatus === "partial"
                      ? localization.t("ported")
                      : localization.t("awaitingParity")}
                  </small>
                </div>
                <span className={provider.implementationStatus === "partial" ? "ready" : "pending"}>
                  {provider.implementationStatus === "partial"
                    ? localization.t("ready")
                    : localization.t("queued")}
                </span>
              </article>
            ))}
          </section>
        </>
      )}
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("Renderer root is missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
