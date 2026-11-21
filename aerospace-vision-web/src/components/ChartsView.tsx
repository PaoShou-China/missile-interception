import { useEffect, useMemo } from "react";
import { useAppStore } from "../state/store";
import { Chart, buildChartSpecs } from "./ChartsPanel";
import { useI18n } from "../i18n";

/** Dedicated data view: every time series on one screen. */
export function ChartsView() {
  const runtime = useAppStore((s) => s.runtime);
  const time = useAppStore((s) => s.time);
  const setPresentation = useAppStore((s) => s.setPresentation);
  const { t } = useI18n();
  const charts = useMemo(
    () => (runtime ? buildChartSpecs(runtime, t) : []),
    [runtime, t],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPresentation("scientific");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPresentation]);

  if (!runtime) return null;

  return (
    <section className="charts-view">
      <header className="charts-view__head">
        <div>
          <span className="panel__eyebrow">{t("topbar.charts")}</span>
          <h2>{t("charts.viewTitle")}</h2>
          <p>{t("charts.viewHint")}</p>
        </div>
        <button type="button" className="charts-view__back" onClick={() => setPresentation("scientific")}>
          {t("topbar.scientific")}
        </button>
      </header>
      <div className="charts-view__grid">
        {charts.map((c) => <Chart key={c.id} spec={c} time={time} />)}
      </div>
    </section>
  );
}
