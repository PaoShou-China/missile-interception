import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import {
  loadComparisonManifest,
  loadDeclaredRun,
  importRunFile,
} from "../compare/loader";
import type { ComparisonManifest, ComparisonMode, CameraPreset, LoadedRun } from "../compare/types";
import {
  buildComparisonMetrics,
  makeSyntheticDemo,
  matchRuns,
  validateComparisonManifest,
  eventAlignmentOffset,
} from "../compare/validation";
import { compareClock, setCompareRange, seekCompare } from "../compare/clock";
import { CompareScene, withSamplers, type CompareRunView } from "../compare/CompareScene";
import { buildCompareSpecs, buildDifferenceSpecs, A_COLOR, B_COLOR } from "../compare/CompareCharts";
import { Chart } from "../components/ChartsPanel";
import { fmt, formatClock } from "../utils/format";

type RuntimeRun = CompareRunView["run"];

const MODES: ComparisonMode[] = ["side-by-side", "overlay", "before-after", "statistics"];
const CAMERAS: CameraPreset[] = ["global", "flight", "attitude", "structure"];
const RATES = [1, 5, 20, 60];

function RunMeta({ run, tag, t }: { run: LoadedRun; tag: "A" | "B"; t: (k: string) => string }) {
  return (
    <div className="cmp-run-meta">
      <div><span>{t("compare.source")}</span><b>{run.meta.algorithm_id} @ {run.meta.algorithm_version}</b></div>
      <div><span>{t("compare.samples")}</span><b>{run.missile.length}</b></div>
      <div><span>{t("compare.timeRange")}</span><b>{formatClock(run.meta.time_start)} – {formatClock(run.meta.time_end)}</b></div>
      <div><span>{t("compare.condition.commit")}</span><b><code>{run.meta.source_commit}</code></b></div>
      <div><span>{t("compare.condition.validation")}</span><b>{run.meta.validation_status}</b></div>
      <div><span>{t("compare.condition.scenario")}</span><b>{run.meta.scenario_id}</b></div>
      {tag === "B" && run.meta.is_synthetic && <span className="cmp-tag cmp-tag--warn">{t("compare.synthetic")}</span>}
    </div>
  );
}

export function ComparePage() {
  const { t } = useI18n();
  const [manifest, setManifest] = useState<ComparisonManifest | null>(null);
  const [runA, setRunA] = useState<RuntimeRun | null>(null);
  const [runB, setRunB] = useState<RuntimeRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [mode, setMode] = useState<ComparisonMode>("side-by-side");
  const [camera, setCamera] = useState<CameraPreset>("global");
  const [sync, setSync] = useState(true);
  const [alignment, setAlignment] = useState<"absolute" | "event">("absolute");
  const [active, setActive] = useState<"A" | "B">("A");
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(20);
  const [uiTime, setUiTime] = useState(0);
  const [split, setSplit] = useState(50);
  const [autoTour, setAutoTour] = useState(false);

  const syncRef = useRef(sync);
  const activeRef = useRef(active);
  const rateRef = useRef(rate);
  const playingRef = useRef(playing);
  useEffect(() => { syncRef.current = sync; }, [sync]);
  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => { rateRef.current = rate; }, [rate]);
  useEffect(() => { playingRef.current = playing; }, [playing]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const m = await loadComparisonManifest();
        const issues = validateComparisonManifest(m).filter((i) => i.severity === "error");
        if (issues.length) throw new Error(issues.map((i) => i.message).join("\n"));
        const declared = m.runs.find((r) => r.availability === "available");
        if (!declared) throw new Error("No available run in comparison manifest");
        const a = withSamplers(await loadDeclaredRun(declared));
        if (cancelled) return;
        setManifest(m);
        setRunA(a);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Common comparison interval: intersection so neither run is extrapolated.
  useEffect(() => {
    if (!runA) return;
    const start = runB ? Math.max(runA.meta.time_start, runB.meta.time_start) : runA.meta.time_start;
    const end = runB ? Math.min(runA.meta.time_end, runB.meta.time_end) : runA.meta.time_end;
    setCompareRange(start, end);
    setUiTime(start);
    setPlaying(false);
    compareClock.rate = rateRef.current;
  }, [runA, runB]);

  // Single comparison clock loop.
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

  // Auto comparison tour.
  useEffect(() => {
    if (!autoTour) return;
    let i = CAMERAS.indexOf(camera);
    const id = window.setInterval(() => {
      i = (i + 1) % CAMERAS.length;
      setCamera(CAMERAS[i]);
    }, 6000);
    return () => window.clearInterval(id);
  }, [autoTour, camera]);

  const eventOffset = useMemo(() => {
    if (!runA || !runB || alignment !== "event") return 0;
    return eventAlignmentOffset(runA.scenario, runB.scenario);
  }, [runA, runB, alignment]);

  const aView = useMemo<CompareRunView | null>(
    () => (runA ? { run: runA, color: A_COLOR, tag: "A", timeKey: "A", offset: 0 } : null),
    [runA],
  );
  const bView = useMemo<CompareRunView | null>(
    () => (runB ? { run: runB, color: B_COLOR, tag: "B", timeKey: "B", offset: eventOffset } : null),
    [runB, eventOffset],
  );

  const match = useMemo(
    () => (runA && runB ? matchRuns(runA.meta, runA.scenario, runB.meta, runB.scenario) : null),
    [runA, runB],
  );
  const level = match?.level ?? "C";

  const metrics = useMemo(
    () => (runA ? buildComparisonMetrics(runA.scenario, runB?.scenario ?? null) : []),
    [runA, runB],
  );

  const chartSpecs = useMemo(
    () => (runA ? buildCompareSpecs(runA, runB, compareClock.timeA, compareClock.timeB, t) : []),
    [runA, runB, t, uiTime],
  );
  const diffSpecs = useMemo(
    () => (runA && runB && sync ? buildDifferenceSpecs(runA, runB, t) : []),
    [runA, runB, sync, t],
  );

  const onImport = async (file: File) => {
    setImportError(null);
    try {
      const b = withSamplers(await importRunFile(file));
      setRunB(b);
      setAlignment("absolute");
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    }
  };

  const loadSynthetic = () => {
    if (!runA) return;
    const base: LoadedRun = { meta: runA.meta, scenario: runA.scenario, missile: runA.missile, target: runA.target };
    setRunB(withSamplers(makeSyntheticDemo(base)));
    setAlignment("absolute");
    setImportError(null);
  };

  if (error) {
    return (
      <article className="page">
        <header className="page-head">
          <p className="kicker">{t("compare.kicker")}</p>
          <h1>{t("compare.title")}</h1>
        </header>
        <p className="callout callout--warn">{t("compare.error")}: {error}</p>
      </article>
    );
  }
  if (!runA || !aView || !manifest) {
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
        <span className="cmp-protocol">{t("compare.protocol")}: {manifest.comparison_protocol.name}</span>
      </div>

      <div className="cmp-runs">
        <section className="cmp-run-card">
          <header><span className="cmp-dot" style={{ background: A_COLOR }} /><b>{t("compare.runA")}</b><span className="cmp-tag cmp-tag--ok">{t("compare.available")}</span></header>
          <RunMeta run={runA} tag="A" t={t} />
        </section>
        <section className="cmp-run-card">
          <header><span className="cmp-dot" style={{ background: B_COLOR }} /><b>{t("compare.runB")}</b>
            <span className={`cmp-tag ${runB ? (runB.meta.is_synthetic ? "cmp-tag--warn" : "cmp-tag--ok") : "cmp-tag--muted"}`}>
              {runB ? (runB.meta.is_synthetic ? t("compare.synthetic") : t("compare.bImported")) : t("compare.awaiting")}
            </span>
          </header>
          {runB ? (
            <>
              <RunMeta run={runB} tag="B" t={t} />
              <button type="button" className="cmp-link" onClick={() => setRunB(null)}>{t("compare.clearB")}</button>
            </>
          ) : (
            <>
              <p className="cmp-muted">{t("compare.noBDesc")}</p>
              <label className="cmp-import">
                <input type="file" accept="application/json,.json" onChange={(e) => e.target.files?.[0] && onImport(e.target.files[0])} />
                <span>{t("compare.import")}</span>
              </label>
              <p className="cmp-hint">{t("compare.importHint")}</p>
              <button type="button" className="cmp-link" onClick={loadSynthetic}>{t("compare.syntheticLoad")}</button>
            </>
          )}
          {importError && <p className="cmp-error">{t("compare.importError")}: {importError}</p>}
        </section>
      </div>

      {runB?.meta.is_synthetic && <p className="callout callout--warn">{t("compare.demoBanner")}</p>}

      <div className="cmp-toolbar">
        <div className="cmp-seg" role="tablist" aria-label={t("compare.title")}>
          {MODES.map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? "is-active" : ""} onClick={() => setMode(m)}>
              {t(`compare.mode.${m === "before-after" ? "slider" : m === "statistics" ? "stats" : m}`)}
            </button>
          ))}
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
            const v = e.target.checked;
            setSync(v);
            if (v) compareClock.timeB = compareClock.timeA;
          }} />
          {t("compare.sync")}
        </label>
        <label className="cmp-check">
          <input type="checkbox" checked={autoTour} onChange={(e) => setAutoTour(e.target.checked)} title={t("compare.autoDemoHint")} />
          {t("compare.autoDemo")}
        </label>
        <span className="cmp-mode-hint">{t(`compare.mode.${mode === "before-after" ? "slider" : mode === "statistics" ? "stats" : mode}Hint`)}</span>
      </div>

      {!sync && (
        <div className="cmp-toolbar cmp-toolbar--independent">
          <span>{t("compare.activeRun")}</span>
          <div className="cmp-seg">
            <button type="button" className={active === "A" ? "is-active" : ""} onClick={() => setActive("A")}>A</button>
            <button type="button" className={active === "B" ? "is-active" : ""} disabled={!runB} onClick={() => setActive("B")}>B</button>
          </div>
          <span className="cmp-hint">{t("compare.chart.diffHint")}</span>
        </div>
      )}

      {runB && (
        <div className="cmp-toolbar cmp-toolbar--alignment">
          <span>{t("compare.sync")}</span>
          <div className="cmp-seg">
            <button type="button" className={alignment === "absolute" ? "is-active" : ""} onClick={() => setAlignment("absolute")}>Absolute</button>
            <button type="button" className={alignment === "event" ? "is-active" : ""} onClick={() => setAlignment("event")}>Event-Aligned</button>
          </div>
          {alignment === "event" && <span className="cmp-warning">Event-Aligned ≠ same absolute time</span>}
        </div>
      )}

      {mode !== "statistics" && (
        <div className="cmp-stage">
          {mode === "side-by-side" && (
            <div className="cmp-split">
              <div className="cmp-pane">
                <span className="cmp-pane-label">A</span>
                <CompareScene runs={[aView]} reference={aView} cameraPreset={camera} />
              </div>
              <div className="cmp-pane">
                <span className="cmp-pane-label cmp-pane-label--b">B</span>
                {bView ? <CompareScene runs={[bView]} reference={aView} cameraPreset={camera} /> : (
                  <div className="cmp-empty">
                    <b>{t("compare.noB")}</b>
                    <p>{t("compare.noBDesc")}</p>
                    <label className="cmp-import">
                      <input type="file" accept="application/json,.json" onChange={(e) => e.target.files?.[0] && onImport(e.target.files[0])} />
                      <span>{t("compare.import")}</span>
                    </label>
                    <button type="button" className="cmp-link" onClick={loadSynthetic}>{t("compare.syntheticLoad")}</button>
                  </div>
                )}
              </div>
            </div>
          )}

          {mode === "overlay" && (
            <div className="cmp-overlay-stage">
              <CompareScene runs={bView ? [aView, bView] : [aView]} reference={aView} cameraPreset={camera} />
              <div className="cmp-legend">
                <span><i style={{ background: A_COLOR }} />{t("compare.legendA")}</span>
                {bView && <span><i style={{ background: B_COLOR }} />{t("compare.legendB")}</span>}
                {!bView && <span className="cmp-muted">{t("compare.noBOverlay")}</span>}
              </div>
            </div>
          )}

          {mode === "before-after" && (
            <div className="cmp-slider-stage">
              {bView ? (
                <>
                  <div className="cmp-slider-pane"><CompareScene runs={[aView]} reference={aView} cameraPreset={camera} /></div>
                  <div className="cmp-slider-pane cmp-slider-pane--b" style={{ clipPath: `inset(0 0 0 ${split}%)` }}>
                    <CompareScene runs={[bView]} reference={aView} cameraPreset={camera} />
                  </div>
                  <div className="cmp-divider" style={{ left: `${split}%` }} />
                  <input
                    className="cmp-slider-input"
                    type="range"
                    min={0}
                    max={100}
                    value={split}
                    aria-label={t("compare.split")}
                    onChange={(e) => setSplit(Number(e.target.value))}
                  />
                  <span className="cmp-slider-tag cmp-slider-tag--a">A</span>
                  <span className="cmp-slider-tag cmp-slider-tag--b">B</span>
                </>
              ) : (
                <div className="cmp-empty cmp-empty--wide">
                  <b>{t("compare.noB")}</b>
                  <p>{t("compare.noBDesc")}</p>
                  <button type="button" className="cmp-link" onClick={loadSynthetic}>{t("compare.syntheticLoad")}</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

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

      {(mode === "statistics" || runB) && (
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
        </section>
      )}

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
                <tr><td>{t("compare.condition.scenario")}</td><td>{runA.meta.scenario_id}</td><td>{runB!.meta.scenario_id}</td></tr>
                <tr><td>{t("compare.condition.hash")}</td><td><code>{runA.meta.configuration_hash}</code></td><td><code>{runB!.meta.configuration_hash}</code></td></tr>
                <tr><td>{t("compare.condition.commit")}</td><td><code>{runA.meta.source_commit}</code></td><td><code>{runB!.meta.source_commit}</code></td></tr>
                <tr><td>{t("compare.condition.validation")}</td><td>{runA.meta.validation_status}</td><td>{runB!.meta.validation_status}</td></tr>
                <tr><td>{t("compare.condition.algorithm")}</td><td>{runA.meta.algorithm_id}</td><td>{runB!.meta.algorithm_id}</td></tr>
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

      <section className="cmp-section">
        <h2>{t("compare.metrics")}</h2>
        <table className="cmp-table">
          <thead>
            <tr>
              <th>{t("compare.metric")}</th><th>{t("compare.unit")}</th>
              <th>{t("compare.valueA")}</th><th>{t("compare.valueB")}</th><th>{t("compare.delta")}</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => {
              const delta = m.value_a !== null && m.value_b !== null ? m.value_b - m.value_a : null;
              return (
                <tr key={m.metric_id}>
                  <td>{m.display_name}</td>
                  <td>{m.unit}</td>
                  <td>{m.value_a !== null ? fmt(m.value_a, 2) : t("compare.notAvailable")}</td>
                  <td>{m.value_b !== null ? fmt(m.value_b, 2) : t("compare.notAvailable")}</td>
                  <td>{delta !== null ? fmt(delta, 2) : t("compare.notAvailable")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="cmp-hint">{t("compare.honesty")}</p>
      </section>
    </article>
  );
}
