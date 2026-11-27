import { useEffect, useRef } from "react";
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
  const inited = useRef(false);
  const lastSig = useRef("");

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
          <div className="sim-grid">
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
            <div className="sim-row">
              <span>{t("simManeuver")}</span>
              <div className="sim-chips">
                {(["none", "turn", "weave"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`sim-chip ${params.maneuver === m ? "is-active" : ""}`}
                    onClick={() => setParams({ maneuver: m })}
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
          </div>
          <p className="sim-note">
            {busy ? t("simSolving") : `${t("simMs")} ${ms} ms`}
          </p>
          <p className="sim-note">
            {t("simAero")} ·{" "}
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
