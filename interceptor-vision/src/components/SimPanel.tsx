import { useEffect, useRef, useState } from "react";
import { useApp } from "../state";
import { useT } from "../i18n";
import { runSimulation, restoreRecorded, simDefaults } from "../sim/apply";

interface RowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  digits?: number;
  onChange: (v: number) => void;
}

function Row({ label, value, min, max, step, unit, digits = 0, onChange }: RowProps) {
  return (
    <label className="sim-row">
      <span>{label}</span>
      <output>
        {value.toFixed(digits)} <i>{unit}</i>
      </output>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

/**
 * Terminal "what if" solver. Off by default so the recorded payload stays the
 * source of truth; switching to 解算 re-integrates the last leg from the
 * recorded hand-over state with the chosen target geometry and guidance gains.
 */
export function SimPanel() {
  const t = useT();
  const telemetry = useApp((s) => s.telemetry);
  const params = useApp((s) => s.simParams);
  const setParams = useApp((s) => s.setSimParams);
  const active = useApp((s) => s.simActive);
  const busy = useApp((s) => s.simBusy);
  const ms = useApp((s) => s.simMs);
  const lang = useApp((s) => s.lang);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const inited = useRef(false);
  const lastSig = useRef("");

  const applyPreset = (preset: "nominal" | "evade9g" | "weave") => {
    const base = simDefaults();
    if (preset === "nominal") {
      setParams({ ...base, rangeKm: 24, altKm: 15, speedMS: 380, headingDeg: 0, maneuver: "none", maneuverG: 0, navConst: 4.5 });
    } else if (preset === "evade9g") {
      setParams({ ...base, rangeKm: 24, altKm: 12, speedMS: 420, headingDeg: 15, maneuver: "turn", maneuverG: 9.0, navConst: 5.0 });
    } else {
      setParams({ ...base, rangeKm: 35, altKm: 18, speedMS: 600, headingDeg: -10, maneuver: "weave", maneuverG: 6.0, navConst: 5.0 });
    }
  };

  const missM = telemetry?.metrics.missDistanceM;
  const isHit = missM != null && missM <= 15;

  useEffect(() => {
    if (inited.current || !telemetry || active) return;
    inited.current = true;
    setParams(simDefaults());
  }, [telemetry, active, setParams]);

  const sig = JSON.stringify(params);
  useEffect(() => {
    if (!active) return;
    if (lastSig.current === sig) return;
    const id = window.setTimeout(() => {
      lastSig.current = sig;
      runSimulation(params);
    }, 260);
    return () => window.clearTimeout(id);
  }, [sig, active, params]);

  const enable = () => {
    const next = simDefaults();
    setParams(next);
    lastSig.current = JSON.stringify(next);
    runSimulation(next);
  };

  return (
    <section className="group">
      <div className="sim-head">
        <h3>{t("sim")}</h3>
        <div className="segmented segmented--sm">
          <button type="button" className={!active ? "is-active" : ""} onClick={restoreRecorded}>
            {t("simRecorded")}
          </button>
          <button type="button" className={active ? "is-active" : ""} onClick={enable}>
            {t("simSolve")}
          </button>
        </div>
      </div>

      {!active && <p className="sim-note">{t("simHint")}</p>}

      {active && (
        <>
          {missM != null && (
            <div className={`sim-result ${isHit ? "sim-result--hit" : "sim-result--miss"}`}>
              <span className="sim-result__badge">
                {busy ? (lang === "zh" ? "解算中…" : "Solving…") : isHit ? (lang === "zh" ? "命中" : "HIT") : (lang === "zh" ? "脱靶" : "MISS")}
              </span>
              <strong>{missM.toFixed(2)} m</strong>
              <span className="sim-result__ms">{ms} ms</span>
            </div>
          )}

          <div className="sim-row sim-row--wide">
            <span>{lang === "zh" ? "快捷场景" : "Presets"}</span>
            <div className="sim-chips">
              <button type="button" className="sim-chip" onClick={() => applyPreset("nominal")}>
                {lang === "zh" ? "标准拦截" : "Nominal"}
              </button>
              <button type="button" className="sim-chip" onClick={() => applyPreset("evade9g")}>
                {lang === "zh" ? "9g 急转" : "9g Turn"}
              </button>
              <button type="button" className="sim-chip" onClick={() => applyPreset("weave")}>
                {lang === "zh" ? "高速蛇形" : "Weave"}
              </button>
            </div>
          </div>

          <div className="sim-grid">
            <div className="sim-row sim-row--wide">
              <span>{t("simManeuver")}</span>
              <div className="sim-chips">
                {(["none", "turn", "weave"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`sim-chip ${params.maneuver === m ? "is-active" : ""}`}
                    onClick={() =>
                      setParams({
                        maneuver: m,
                        maneuverG: m === "none" ? 0 : Math.max(params.maneuverG, 6.0),
                      })
                    }
                  >
                    {t(m === "none" ? "simNone" : m === "turn" ? "simTurn" : "simWeave")}
                  </button>
                ))}
              </div>
            </div>
            {params.maneuver !== "none" && (
              <Row
                label={t("simManeuverG")}
                value={params.maneuverG}
                min={0.5}
                max={9}
                step={0.5}
                unit="g"
                digits={1}
                onChange={(maneuverG) => setParams({ maneuverG })}
              />
            )}

            <button
              type="button"
              className="sim-adv-toggle sim-row--wide"
              onClick={() => setShowAdvanced((v) => !v)}
              aria-expanded={showAdvanced}
            >
              <span>{lang === "zh" ? "高级参数（模型 / 距离 / 高度 / 速度 / 导航比）" : "Advanced (Model / Range / Alt / Speed / N)"}</span>
              <span>{showAdvanced ? "▴" : "▾"}</span>
            </button>

            {showAdvanced && (
              <>
                <div className="sim-row sim-row--wide">
                  <span>{t("simModel")}</span>
                  <div className="sim-chips">
                    {(["sixdof", "point"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={`sim-chip ${params.model === m ? "is-active" : ""}`}
                        onClick={() => setParams({ model: m })}
                      >
                        {t(m === "sixdof" ? "simModel6" : "simModelPoint")}
                      </button>
                    ))}
                  </div>
                </div>
                <Row
                  label={t("simRange")}
                  value={params.rangeKm}
                  min={3}
                  max={60}
                  step={1}
                  unit="km"
                  digits={0}
                  onChange={(rangeKm) => setParams({ rangeKm })}
                />
                <Row
                  label={t("simAlt")}
                  value={params.altKm}
                  min={1}
                  max={40}
                  step={1}
                  unit="km"
                  onChange={(altKm) => setParams({ altKm })}
                />
                <Row
                  label={t("simSpeed")}
                  value={params.speedMS}
                  min={200}
                  max={3000}
                  step={50}
                  unit="m/s"
                  onChange={(speedMS) => setParams({ speedMS })}
                />
                <Row
                  label={t("simHeading")}
                  value={params.headingDeg}
                  min={-180}
                  max={180}
                  step={5}
                  unit="°"
                  onChange={(headingDeg) => setParams({ headingDeg })}
                />
                <Row
                  label={t("simNav")}
                  value={params.navConst}
                  min={2}
                  max={6}
                  step={0.5}
                  unit=""
                  digits={1}
                  onChange={(navConst) => setParams({ navConst })}
                />
              </>
            )}
          </div>
          <p className="sim-note sim-row--wide">
            {busy ? t("simSolving") : `${t("simMs")} ${ms} ms`} · {t("simAero")} ·{" "}
            <a
              className="sim-link"
              href={`${import.meta.env.BASE_URL}data/aero-interceptor.json`}
              download
            >
              {t("download")} JSON
            </a>
          </p>
        </>
      )}
    </section>
  );
}
