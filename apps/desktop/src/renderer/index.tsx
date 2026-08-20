import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DashboardSnapshotDTO } from "@codexbar/contracts";

import "./styles.css";

function App() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshotDTO>();
  const [error, setError] = useState<string>();
  const [t3Status, setT3Status] = useState<"idle" | "waiting" | "connected">("idle");
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
          <small>USAGE OVERVIEW</small>
          <h1>CodexBar Multi</h1>
        </div>
        <span className="platform">TypeScript</span>
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
            ? "Aguardando login…"
            : t3Status === "connected"
              ? "T3 Chat conectado"
              : "Entrar no T3 Chat"}
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
            Sair
          </button>
        ) : null}
      </div>
      {snapshot === undefined ? (
        <p className="muted">Carregando providers…</p>
      ) : (
        <>
          <p className="muted">
            {
              snapshot.providers.filter((provider) => provider.implementationStatus === "partial")
                .length
            }{" "}
            de {snapshot.providers.length} providers no primeiro corte.
          </p>
          <section>
            {snapshot.providers.map((provider) => (
              <article key={provider.id}>
                <div className="monogram">{provider.name.slice(0, 2).toUpperCase()}</div>
                <div>
                  <strong>{provider.name}</strong>
                  <small>
                    {provider.implementationStatus === "partial"
                      ? "Portado"
                      : "Aguardando paridade"}
                  </small>
                </div>
                <span className={provider.implementationStatus === "partial" ? "ready" : "pending"}>
                  {provider.implementationStatus === "partial" ? "ready" : "queued"}
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
