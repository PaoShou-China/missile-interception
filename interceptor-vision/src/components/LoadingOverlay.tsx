import { useProgress } from "@react-three/drei";
import { useApp } from "../state";
import { useT } from "../i18n";

export function LoadingOverlay() {
  const t = useT();
  const ready = useApp((s) => s.ready);
  const { progress, active } = useProgress();
  const loading = !ready || (active && progress < 100);

  if (!loading) return null;

  return (
    <div className="loading">
      <div className="loading__inner">
        <div className="loading__mark" aria-hidden>
          <span />
          <span />
          <span />
        </div>
        <p className="loading__title">{t("loading")}</p>
        <p className="loading__hint">{t("loadingHint")}</p>
        <div className="loading__bar">
          <span style={{ width: `${Math.max(4, Math.round(progress))}%` }} />
        </div>
        <div className="loading__pct">{Math.round(progress)}%</div>
      </div>
    </div>
  );
}
