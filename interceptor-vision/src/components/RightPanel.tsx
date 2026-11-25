import { useApp } from "../state";
import { useT } from "../i18n";
import { TelemetryPanel } from "./TelemetryPanel";

export function RightPanel() {
  const t = useT();
  const open = useApp((s) => s.rightOpen);
  const toggle = useApp((s) => s.toggleRight);

  return (
    <>
      <aside className={`rail rail--right ${open ? "" : "is-collapsed"}`}>
        <div className="panel-head">
          <span>{t("telemetry")}</span>
          <button type="button" className="panel-collapse" onClick={toggle} aria-label={t("hideUi")}>
            ›
          </button>
        </div>

        <TelemetryPanel />
      </aside>

      {!open && (
        <button type="button" className="rail-handle rail-handle--right" onClick={toggle} title={`${t("telemetry")} · ${t("expand")}`}>
          {t("telemetry")}
        </button>
      )}
    </>
  );
}
