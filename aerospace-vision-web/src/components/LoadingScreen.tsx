import { useEffect, useState } from "react";
import { useProgress } from "@react-three/drei";
import { useAppStore } from "../state/store";
import { useI18n } from "../i18n";

export function LoadingScreen() {
  const status = useAppStore((s) => s.status);
  const error = useAppStore((s) => s.error);
  const { progress } = useProgress();
  const [timedOut, setTimedOut] = useState(false);
  const { t } = useI18n();

  useEffect(() => {
    if (status !== "ready") return;
    const id = window.setTimeout(() => setTimedOut(true), 5000);
    return () => window.clearTimeout(id);
  }, [status]);

  // Keep the curtain until both the scenario and the Earth textures are ready,
  // but never let a stalled texture loader block the interface indefinitely.
  const assetsPending = progress < 100 && !timedOut;
  if (status === "ready" && !assetsPending) return null;

  return (
    <div className="loading">
      <div className="loading__grid" aria-hidden />
      <div className="loading__content">
        <div className="loading__brand">{t("brand.latin")}</div>
        <h1>{t("loading.title")}</h1>
        {status === "error" ? (
          <>
            <p className="loading__error">{t("loading.error")}</p>
            <pre>{error}</pre>
            <p className="loading__hint">
              <code>npm run data:build</code> — {t("loading.buildHint")}
            </p>
          </>
        ) : (
          <>
            <p className="loading__stage">
              {t("loading.stage")}
              {assetsPending ? ` · ${t("loading.textures")} ${Math.round(progress)}%` : ""}
            </p>
            <div className="loading__bar"><span /></div>
            <p className="loading__hint">{t("loading.hint")}</p>
          </>
        )}
      </div>
    </div>
  );
}
