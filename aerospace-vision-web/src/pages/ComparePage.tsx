import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { loadComparisonManifest, loadDeclaredRun } from "../compare/loader";
import type { ComparisonManifest, CameraPreset } from "../compare/types";
import {
  buildComparisonMetrics,
  makeSyntheticDemo,
  matchRuns,
} from "../compare/validation";
import {
  loadRegistry,
  loadCampaign,
  findExperiment,
  localized,
  optionById,
  campaignStat,
  sharedCampaignRef,
  type CampaignManifest,
  type CampaignStat,
  type ExperimentCombo,
  type ExperimentRecord,
  type ExperimentRegistry,
} from "../compare/registry";
import { compareClock, setCompareRange, seekCompare } from "../compare/clock";
import { CompareScene, withSamplers, type CompareRunView } from "../compare/CompareScene";
import { buildCompareSpecs, buildDifferenceSpecs, A_COLOR, B_COLOR } from "../compare/CompareCharts";
import { Chart } from "../components/ChartsPanel";
import { fmt, formatClock } from "../utils/format";

type RuntimeRun = CompareRunView["run"];
type StageMode = "side" | "overlay";

const CAMERAS: CameraPreset[] = ["global", "flight", "attitude", "structure"];
const RATES = [1, 5, 20, 60];
const SAVE_KEY = "av.compare.selection";

function ConfigPanel({
  tag,
  sel,
  onChange,
  registry,
  t,
  lang,
}: {
  tag: "A" | "B";
  sel: ExperimentCombo;
  onChange: (next: ExperimentCombo) => void;
  registry: ExperimentRegistry;
  t: (k: string) => string;
  lang: "zh" | "en";
}) {
  const exp = findExperiment(registry, sel);
  const vehicle = optionById(registry.vehicles, sel.vehicle);

  const select = (field: keyof ExperimentCombo, options: { id: string; label: string }[]) => (
    <label className="cfg-field">
      <span>{t(`cfg.${field}`)}</span>
      <select value={sel[field]} onChange={(e) => onChange({ ...sel, [field]: e.target.value })}>
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </label>
  );

  return (
    <section className={`cfg-card cfg-card--${tag}`}>
      <header>
        <span className="cfg-dot" style={{ background: tag === "A" ? A_COLOR : B_COLOR }} />
        <b>{tag === "A" ? t("compare.runA") : t("compare.runB")}</b>
        <span className={`cmp-tag ${exp ? (exp.synthetic ? "cmp-tag--warn" : "cmp-tag--ok") : "cmp-tag--muted"}`}>
          {exp ? (exp.synthetic ? t("compare.synthetic") : exp.validation_status) : t("compare.awaiting")}
        </span>
      </header>

      {select("guidance", registry.guidance.map((o) => ({ id: o.id, label: localized(o.name, lang) })))}
      {select("control", registry.control.map((o) => ({ id: o.id, label: localized(o.name, lang) })))}
      {select("vehicle", registry.vehicles.map((o) => ({ id: o.id, label: localized(o.name, lang) })))}
      {select("scenario", registry.scenarios.map((o) => ({
        id: o.id,
        label: localized(o.name, lang) + (o.synthetic ? " ⚠" : ""),
      })))}

      {vehicle && (
        <div className="cfg-profile">
          <div className="cfg-profile__head">
            <span>{t("cfg.profile")}</span>
            <button type="button" onClick={() => onChange({ ...sel, vehicle: vehicle.id })}>{vehicle.version}</button>
          </div>
          <dl>
            <div><dt>{t("cfg.length")}</dt><dd>{vehicle.length_m} m</dd></div>
            <div><dt>{t("cfg.diameter")}</dt><dd>{vehicle.diameter_m} m</dd></div>
            <div><dt>{t("cfg.launchMass")}</dt><dd>{vehicle.launch_mass_kg} kg</dd></div>
            <div><dt>{t("cfg.dryMass")}</dt><dd>{vehicle.dry_mass_kg} kg</dd></div>
            <div><dt>{t("cfg.finSpan")}</dt><dd>{vehicle.fin_span_m} m</dd></div>
            <div><dt>{t("cfg.version")}</dt><dd>{vehicle.version}</dd></div>
          </dl>
          <p>{localized(vehicle.physical_note, lang)}</p>
          <code>{vehicle.source}</code>
        </div>
      )}

      {!exp && <p className="cfg-unavailable">{t("cfg.noExperiment")}</p>}
      {exp && (
        <p className="cfg-experiment">
          <span>{exp.id}</span>
          <b>{exp.synthetic ? t("compare.synthetic") : exp.run.scenario_id}</b>
        </p>
      )}
    </section>
  );
}

export function ComparePage() {
  const { t, lang } = useI18n();
  const [registry, setRegistry] = useState<ExperimentRegistry | null>(null);
  const [manifest, setManifest] = useState<ComparisonManifest | null>(null);
  const [campaign, setCampaign] = useState<CampaignManifest | null>(null);
  const [selA, setSelA] = useState<ExperimentCombo | null>(null);
  const [selB, setSelB] = useState<ExperimentCombo | null>(null);
  const [runA, setRunA] = useState<RuntimeRun | null>(null);
  const [runB, setRunB] = useState<RuntimeRun | null>(null);
  const [stage, setStage] = useState<StageMode>("side");
  const [camera, setCamera] = useState<CameraPreset>("global");
  const [sync, setSync] = useState(true);
  const [active, setActive] = useState<"A" | "B">("A");
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(20);
  const [modelScale, setModelScale] = useState(1);
  const [uiTime, setUiTime] = useState(0);
  const [configError, setConfigError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savedRef, setSavedRef] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const syncRef = useRef(sync);
  const activeRef = useRef(active);
  const rateRef = useRef(rate);
  const playingRef = useRef(playing);
  useEffect(() => { syncRef.current = sync; }, [sync]);
  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => { rateRef.current = rate; }, [rate]);
  useEffect(() => { playingRef.current = playing; }, [playing]);

  const buildRuns = async (reg: ExperimentRegistry, a: ExperimentCombo, b: ExperimentCombo) => {
    const expA = findExperiment(reg, a);
    const expB = findExperiment(reg, b);
    if (!expA || !expB) {
      setConfigError(t("cfg.noExperiment"));
      return;
    }
    setConfigError(null);
    setLoadError(null);
    try {
      const real = (exp: ExperimentRecord) => loadDeclaredRun(exp.run);
      const needsBaseline = expA.synthetic || expB.synthetic;
      const baselineExp = reg.experiments.find((e) => !e.synthetic && e.run.trajectory_file);
      if (needsBaseline && !baselineExp) throw new Error(t("cfg.noExperiment"));
      const [loadedA, loadedB, baseline] = await Promise.all([
        expA.synthetic ? Promise.resolve(null) : real(expA),
        expB.synthetic ? Promise.resolve(null) : real(expB),
        needsBaseline ? real(baselineExp!) : Promise.resolve(null),
      ]);
      const materialize = (exp: ExperimentRecord, loaded: Awaited<ReturnType<typeof real>> | null): RuntimeRun => {
        if (!exp.synthetic) return withSamplers(loaded!);
        const demo = makeSyntheticDemo(baseline!);
        demo.meta = { ...exp.run };
        demo.scenario = {
          ...baseline!.scenario,
          id: exp.run.scenario_id,
          title: exp.run.display_name,
          validation: { status: "NOT RUN", checks: [] },
        };
        return withSamplers(demo);
      };
      setRunA(materialize(expA, loadedA));
      setRunB(materialize(expB, loadedB));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [reg, man, camp] = await Promise.all([
          loadRegistry(),
          loadComparisonManifest(),
          loadCampaign(),
        ]);
        if (cancelled) return;
        setRegistry(reg);
        setManifest(man);
        setCampaign(camp);
        const realRuns = reg.experiments.filter((e) => !e.synthetic);
        const a = (realRuns.find((e) => e.id === "exp-campaign-bezier-zem") ?? realRuns[0]!).combo;
        const b = (realRuns.find((e) => e.id === "exp-campaign-classic-full")
          ?? realRuns.find((e) => e.id === "exp-campaign-bezier-pn")
          ?? realRuns[1] ?? realRuns[0]!).combo;
        setSelA(a);
        setSelB(b);
        await buildRuns(reg, a, b);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!runA) return;
    const start = runB ? Math.max(runA.meta.time_start, runB.meta.time_start) : runA.meta.time_start;
    const end = runB ? Math.min(runA.meta.time_end, runB.meta.time_end) : runA.meta.time_end;
    setCompareRange(start, end);
    setUiTime(start);
    setPlaying(false);
  }, [runA, runB]);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let mirror = 0;
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (playingRef.current) {
        const advance = dt * rateRef.current;
        if (syncRef.current) {
          compareClock.timeA = Math.min(compareClock.end, compareClock.timeA + advance);
          compareClock.timeB = compareClock.timeA;
          if (compareClock.timeA >= compareClock.end) setPlaying(false);
        } else if (activeRef.current === "A") {
          compareClock.timeA = Math.min(compareClock.end, compareClock.timeA + advance);
        } else {
          compareClock.timeB = Math.min(compareClock.end, compareClock.timeB + advance);
        }
      }
      mirror += dt;
      if (mirror > 0.1) {
        mirror = 0;
        setUiTime(syncRef.current ? compareClock.timeA : activeRef.current === "A" ? compareClock.timeA : compareClock.timeB);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const aView = useMemo<CompareRunView | null>(
    () => (runA ? { run: runA, color: A_COLOR, tag: "A", timeKey: "A", offset: 0 } : null),
    [runA],
  );
  const bView = useMemo<CompareRunView | null>(
    () => (runB ? { run: runB, color: B_COLOR, tag: "B", timeKey: "B", offset: 0 } : null),
    [runB],
  );

  const sameConfig = selA && selB
    ? Object.keys(selA).every((k) => selA[k as keyof ExperimentCombo] === selB[k as keyof ExperimentCombo])
    : false;
  const match = useMemo(() => {
    if (!runA || !runB) return null;
    const m = matchRuns(runA.meta, runA.scenario, runB.meta, runB.scenario);
    if (sameConfig) {
      return {
        ...m,
        level: "C" as const,
        eligibleForPerformanceClaims: false,
        issues: [...m.issues, { field: "selection", a: "A", b: "B", severity: "blocking" as const, message: t("cfg.sameConfig") }],
      };
    }
    return m;
  }, [runA, runB, sameConfig, t]);
  const level = match?.level ?? "C";
  const synthetic = Boolean(runA?.meta.is_synthetic || runB?.meta.is_synthetic);
  const deltaEligible = Boolean(match && match.level !== "C" && !synthetic);

  const metrics = useMemo(
    () => (runA ? buildComparisonMetrics(runA.scenario, runB?.scenario ?? null) : []),
    [runA, runB],
  );
  const chartSpecs = useMemo(
    () => (runA ? buildCompareSpecs(runA, runB, compareClock.timeA, compareClock.timeB, t) : []),
    [runA, runB, t],
  );
  const diffSpecs = useMemo(
    () => (runA && runB && sync && deltaEligible ? buildDifferenceSpecs(runA, runB, t) : []),
    [runA, runB, sync, deltaEligible, t],
  );

  const onCompare = async () => {
    if (!registry || !selA || !selB) return;
    await buildRuns(registry, selA, selB);
  };

  const onSwap = () => {
    setSelA(selB);
    setSelB(selA);
    setRunA(runB);
    setRunB(runA);
    setPlaying(false);
  };

  const saveReference = async () => {
    if (!registry || !selA || !selB) return;
    const ref = {
      registry_id: registry.registry_id,
      generated_from: registry.generated_from,
      saved_at: new Date().toISOString(),
      a: { selection: selA, experiment: findExperiment(registry, selA)?.id ?? null },
      b: { selection: selB, experiment: findExperiment(registry, selB)?.id ?? null },
    };
    const text = JSON.stringify(ref, null, 2);
    localStorage.setItem(SAVE_KEY, text);
    setSavedRef(text);
    try {
      await navigator.clipboard.writeText(text);
      setToast(t("cfg.saved"));
    } catch {
      setToast(t("cfg.saveFail"));
    }
    window.setTimeout(() => setToast(null), 2500);
  };

  if (loadError) {
    return (
      <article className="page">
        <header className="page-head">
          <p className="kicker">{t("compare.kicker")}</p>
          <h1>{t("compare.title")}</h1>
        </header>
        <p className="callout callout--warn">{t("compare.error")}: {loadError}</p>
      </article>
    );
  }
  if (!registry || !selA || !selB || !runA || !aView || !manifest) {
    return (
      <article className="page">
        <header className="page-head">
          <p className="kicker">{t("compare.kicker")}</p>
          <h1>{t("compare.title")}</h1>
        </header>
        <p className="cmp-loading">{t("compare.loading")}</p>
      </article>
    );
  }

  const end = runB ? Math.min(runA.meta.time_end, runB.meta.time_end) : runA.meta.time_end;
  const start = runB ? Math.max(runA.meta.time_start, runB.meta.time_start) : runA.meta.time_start;
  const expA = findExperiment(registry, selA);
  const expB = findExperiment(registry, selB);
  const shared = sharedCampaignRef(expA, expB);
  const statA = campaignStat(campaign, shared?.a);
  const statB = campaignStat(campaign, shared?.b);
  const campaignRows: { key: keyof CampaignStat; label: string; unit: string; digits: number }[] = [
    { key: "hit_rate", label: t("campaign.hitRate"), unit: "%", digits: 1 },
    { key: "miss_median", label: t("campaign.missMedian"), unit: "m", digits: 2 },
    { key: "miss_p90", label: t("campaign.missP90"), unit: "m", digits: 2 },
    { key: "miss_mean", label: t("campaign.missMean"), unit: "m", digits: 2 },
    { key: "miss_max", label: t("campaign.missMax"), unit: "m", digits: 2 },
    { key: "handover_range_km", label: t("campaign.handoverRange"), unit: "km", digits: 2 },
    { key: "handover_energy_mjkg", label: t("campaign.handoverEnergy"), unit: "MJ/kg", digits: 2 },
    { key: "boost_end_alt_km", label: t("campaign.boostAlt"), unit: "km", digits: 2 },
    { key: "boost_end_mach", label: t("campaign.boostMach"), unit: "—", digits: 2 },
    { key: "midcourse_peak_mach", label: t("campaign.peakMach"), unit: "—", digits: 2 },
    { key: "terminal_fin_sat_pct", label: t("campaign.finSat"), unit: "%", digits: 1 },
  ];
  const statValue = (stat: CampaignStat | null, key: keyof CampaignStat, digits: number) => {
    if (!stat) return t("compare.notAvailable");
    const v = stat[key];
    if (typeof v !== "number" || !Number.isFinite(v)) return t("compare.notAvailable");
    if (key === "hit_rate") return `${(v * 100).toFixed(digits)}%`;
    return fmt(v, digits);
  };

  return (
    <article className="page compare-page">
      <header className="page-head">
        <p className="kicker">{t("compare.kicker")}</p>
        <h1>{t("compare.title")}</h1>
        <p className="lede">{t("compare.lede")}</p>
      </header>

      <div className="cmp-badges">
        <span className={`cmp-level cmp-level--${level}`}>{t("compare.level")}: {t(`compare.level.${level}`)}</span>
        <span className={`cmp-eligibility ${match?.eligibleForPerformanceClaims ? "is-ok" : "is-warn"}`}>
          {match?.eligibleForPerformanceClaims ? t("compare.eligible") : t("compare.notEligible")}
        </span>
        <span className="cmp-protocol">{manifest.comparison_protocol.name}</span>
      </div>

      <section className="cfg-studio">
        <div className="cfg-head">
          <h2>{t("cfg.title")}</h2>
          <div className="cfg-actions">
            <button type="button" className="cfg-compare" onClick={onCompare} disabled={!expA || !expB}>
              {t("cfg.compare")}
            </button>
            <button type="button" className="cfg-secondary" onClick={onSwap}>{t("cfg.swap")}</button>
            <button type="button" className="cfg-secondary" onClick={saveReference}>{t("cfg.save")}</button>
          </div>
        </div>
        <div className="cfg-grid">
          <ConfigPanel tag="A" sel={selA} onChange={setSelA} registry={registry} t={t} lang={lang} />
          <ConfigPanel tag="B" sel={selB} onChange={setSelB} registry={registry} t={t} lang={lang} />
        </div>
        {configError && <p className="cmp-error">{configError}</p>}
        {(!expA || !expB) && <p className="cfg-unavailable">{!expB ? t("cfg.needB") : t("cfg.noExperiment")}</p>}
        {sameConfig && <p className="cmp-warning">{t("cfg.sameConfig")}</p>}
        {toast && <p className="cfg-toast">{toast}</p>}
        {savedRef && (
          <details className="cfg-saved">
            <summary>{t("cfg.savedRef")}</summary>
            <pre>{savedRef}</pre>
          </details>
        )}
      </section>

      {synthetic && <p className="callout callout--warn">{t("compare.demoBanner")}</p>}

      <div className="cmp-toolbar">
        <div className="cmp-seg">
          <button type="button" className={stage === "side" ? "is-active" : ""} onClick={() => setStage("side")}>{t("cfg.side")}</button>
          <button type="button" className={stage === "overlay" ? "is-active" : ""} onClick={() => setStage("overlay")}>{t("cfg.overlay")}</button>
        </div>
        <div className="cmp-seg cmp-seg--camera">
          <span>{t("compare.camera")}</span>
          {CAMERAS.map((c) => (
            <button key={c} type="button" aria-pressed={camera === c} className={camera === c ? "is-active" : ""} onClick={() => setCamera(c)}>
              {t(`compare.cam.${c}`)}
            </button>
          ))}
        </div>
        <label className="cmp-check">
          <input type="checkbox" checked={sync} onChange={(e) => {
            setSync(e.target.checked);
            if (e.target.checked) compareClock.timeB = compareClock.timeA;
          }} />
          {t("compare.sync")}
        </label>
        <label className="cmp-scale">
          <span>{t("cfg.modelScale")}</span>
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.1}
            value={modelScale}
            onChange={(e) => setModelScale(Number(e.target.value))}
          />
          <b>{modelScale.toFixed(1)}×</b>
        </label>
        <span className="cmp-mode-hint">{t("cfg.visualOnly")}</span>
      </div>

      {!sync && (
        <div className="cmp-toolbar cmp-toolbar--independent">
          <span>{t("compare.activeRun")}</span>
          <div className="cmp-seg">
            <button type="button" className={active === "A" ? "is-active" : ""} onClick={() => setActive("A")}>A</button>
            <button type="button" className={active === "B" ? "is-active" : ""} onClick={() => setActive("B")}>B</button>
          </div>
        </div>
      )}

      <div className="cmp-stage">
        {stage === "side" ? (
          <div className="cmp-split">
            <div className="cmp-pane">
              <span className="cmp-pane-label">A</span>
              <CompareScene runs={[aView]} reference={aView} cameraPreset={camera} modelScale={modelScale} />
            </div>
            <div className="cmp-pane">
              <span className="cmp-pane-label cmp-pane-label--b">B</span>
              {bView ? <CompareScene runs={[bView]} reference={aView} cameraPreset={camera} modelScale={modelScale} /> : (
                <div className="cmp-empty"><b>{t("compare.noB")}</b><p>{t("cfg.noExperiment")}</p></div>
              )}
            </div>
          </div>
        ) : (
          <div className="cmp-overlay-stage">
            <CompareScene runs={bView ? [aView, bView] : [aView]} reference={aView} cameraPreset={camera} modelScale={modelScale} />
            <div className="cmp-legend">
              <span><i style={{ background: A_COLOR }} />{t("compare.legendA")}</span>
              {bView && <span><i style={{ background: B_COLOR }} />{t("compare.legendB")}</span>}
            </div>
          </div>
        )}
      </div>

      <div className="cmp-timebar">
        <button type="button" className="cmp-play" onClick={() => setPlaying((p) => !p)}>
          {playing ? t("compare.pause") : t("compare.play")}
        </button>
        <button type="button" className="cmp-transport" onClick={() => {
          compareClock.timeA = compareClock.start;
          compareClock.timeB = compareClock.start;
          setUiTime(compareClock.start);
          setPlaying(false);
        }} title={t("compare.reset")}>⟲</button>
        <div className="cmp-track">
          <input
            type="range"
            min={start}
            max={end}
            step={0.1}
            value={uiTime}
            aria-label={t("compare.time")}
            onChange={(e) => { seekCompare(Number(e.target.value), active, sync); setUiTime(Number(e.target.value)); }}
          />
          <div className="cmp-track-labels">
            <span>{formatClock(start)}</span>
            <b>{formatClock(uiTime)}</b>
            <span>{formatClock(end)}</span>
          </div>
        </div>
        <div className="cmp-rates">
          {RATES.map((r) => (
            <button key={r} type="button" className={rate === r ? "is-active" : ""} onClick={() => { setRate(r); compareClock.rate = r; }}>{r}×</button>
          ))}
        </div>
      </div>

      <section className="cmp-section">
        <h2>{t("compare.charts")}</h2>
        <div className="cmp-chart-grid">
          {chartSpecs.map((c) => <Chart key={c.id} spec={c} time={uiTime} />)}
        </div>
        {diffSpecs.length > 0 && (
          <>
            <h3>{t("compare.chart.diff")}</h3>
            <p className="cmp-hint">{t("compare.chart.diffHint")}</p>
            <div className="cmp-chart-grid">
              {diffSpecs.map((c) => <Chart key={c.id} spec={c} time={uiTime} />)}
            </div>
          </>
        )}
        {runB && !deltaEligible && <p className="cmp-warning">{t("cfg.notEligibleDelta")}</p>}
      </section>

      {shared && statA && statB && campaign && (
        <section className="cmp-section cmp-campaign">
          <h2>{t("campaign.title")}</h2>
          <p className="cmp-hint">
            {t("campaign.note")} · N = {statA.n_valid} / {statB.n_valid} ·{" "}
            {campaign.levels_g[shared.b.stage].map((v) => `${v}g`).join(" / ")}
          </p>
          <p className="cmp-hint">
            {t("campaign.slice")}: {shared.b.stage} · {shared.b.law} · {shared.b.level_g} g ·{" "}
            {campaign.campaign_id} · seed {campaign.seed}
          </p>
          <table className="cmp-table">
            <thead>
              <tr>
                <th>{t("compare.metric")}</th><th>{t("compare.unit")}</th>
                <th>{t("compare.valueA")}</th><th>{t("compare.valueB")}</th>
                <th>{t("compare.delta")}</th><th>{t("cfg.source")}</th>
              </tr>
            </thead>
            <tbody>
              {campaignRows.filter((row) => typeof statA[row.key] === "number" || typeof statB[row.key] === "number").map((row) => {
                const va = statA[row.key];
                const vb = statB[row.key];
                const delta = typeof va === "number" && typeof vb === "number"
                  && Number.isFinite(va) && Number.isFinite(vb) ? vb - va : null;
                const deltaText = delta === null
                  ? t("compare.notAvailable")
                  : row.key === "hit_rate"
                    ? `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(row.digits)} pp`
                    : `${delta >= 0 ? "+" : ""}${fmt(delta, row.digits)}`;
                return (
                  <tr key={row.key}>
                    <td>{row.label}</td>
                    <td>{row.unit}</td>
                    <td>{statValue(statA, row.key, row.digits)}</td>
                    <td>{statValue(statB, row.key, row.digits)}</td>
                    <td>{deltaText}</td>
                    <td><code>campaign.json</code></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="cmp-hint">{t("campaign.footer")}</p>
        </section>
      )}

      <section className="cmp-section">
        <h2>{t("cfg.summary")}</h2>
        <table className="cmp-table">
          <thead>
            <tr>
              <th>{t("compare.metric")}</th><th>{t("compare.unit")}</th>
              <th>{t("compare.valueA")}</th><th>{t("compare.valueB")}</th><th>{t("compare.delta")}</th>
              <th>{t("cfg.source")}</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => {
              const delta = deltaEligible && m.value_a !== null && m.value_b !== null ? m.value_b - m.value_a : null;
              return (
                <tr key={m.metric_id}>
                  <td>{m.display_name}</td>
                  <td>{m.unit}</td>
                  <td>{m.value_a !== null ? fmt(m.value_a, 2) : t("compare.notAvailable")}</td>
                  <td>{m.value_b !== null ? fmt(m.value_b, 2) : t("compare.notAvailable")}</td>
                  <td>{delta !== null ? fmt(delta, 2) : t("compare.notAvailable")}</td>
                  <td><code>{m.data_source}</code></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="cmp-hint">{t("cfg.deltaEligible")}</p>
      </section>

      <section className="cmp-section">
        <h2>{t("compare.conditions")}</h2>
        {match ? (
          <>
            <p className={level === "C" ? "cmp-warning" : level === "B" ? "cmp-hint" : "cmp-ok"}>
              {level === "C" ? t("compare.matchBlocked") : level === "B" ? t("compare.matchWarning") : t("compare.noDiff")}
            </p>
            <table className="cmp-table">
              <thead><tr><th>{t("compare.metric")}</th><th>A</th><th>B</th></tr></thead>
              <tbody>
                <tr><td>{t("cfg.guidance")}</td><td>{expA?.combo.guidance}</td><td>{expB?.combo.guidance}</td></tr>
                <tr><td>{t("cfg.control")}</td><td>{expA?.combo.control}</td><td>{expB?.combo.control}</td></tr>
                <tr><td>{t("cfg.vehicle")}</td><td>{expA?.combo.vehicle}</td><td>{expB?.combo.vehicle}</td></tr>
                <tr><td>{t("cfg.scenario")}</td><td>{expA?.combo.scenario}</td><td>{expB?.combo.scenario}</td></tr>
                <tr><td>{t("compare.condition.hash")}</td><td><code>{runA.meta.configuration_hash}</code></td><td><code>{runB?.meta.configuration_hash}</code></td></tr>
                <tr><td>{t("compare.condition.commit")}</td><td><code>{runA.meta.source_commit}</code></td><td><code>{runB?.meta.source_commit}</code></td></tr>
                <tr><td>{t("compare.condition.validation")}</td><td>{runA.meta.validation_status}</td><td>{runB?.meta.validation_status}</td></tr>
              </tbody>
            </table>
            {match.issues.length > 0 && (
              <ul className="cmp-issues">
                {match.issues.map((i) => (
                  <li key={i.field} className={i.severity === "blocking" ? "is-blocking" : "is-warning"}>
                    <b>{i.field}</b>: A={i.a} / B={i.b} — {i.message}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="cmp-muted">{t("compare.noBDesc")}</p>
        )}
      </section>

      <p className="cmp-hint">{t("compare.honesty")}</p>
    </article>
  );
}
