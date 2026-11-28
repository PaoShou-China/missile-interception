import { useState } from "react";
import { useApp } from "../state";
import { useT, type StringKey } from "../i18n";
import { sampleAt, formatMissionTime, seekDataTime, type FlightEvent } from "../data/telemetry";

const EVENT_KEY: Record<string, StringKey> = {
  launch: "eventLaunch",
  phase: "eventPhase",
  stage: "eventSeparation",
  peak: "eventPeak",
  lock: "eventLock",
  handover: "eventHandover",
  intercept: "eventIntercept",
  custom: "eventPhase",
};

function phaseNarrative(tSec: number, endSec: number, rangeKm: number, seekerLock: boolean, decoyOn: boolean, lang: "zh" | "en"): string {
  if (tSec < 13) {
    return lang === "zh"
      ? "助推点火爬升：固体火箭全推力加速至马赫 5+，快速穿出稠密大气层。"
      : "Booster ascent: solid rocket accelerates past Mach 5 out of dense lower atmosphere.";
  }
  if (tSec < 20) {
    return lang === "zh"
      ? "级间分离与超燃接力：抛离助推壳体，超燃冲压发动机点火切入高超声速巡航。"
      : "Stage separation: booster jettisoned, scramjet ignites for hypersonic cruise.";
  }
  if (endSec - tSec <= 1.2) {
    return lang === "zh"
      ? "末段精准交会：近炸引信起爆形成定向破片环，实现米级直接拦截。"
      : "Terminal intercept: directional fragmentation warhead detonates within lethal radius.";
  }
  if (seekerLock || rangeKm <= 30) {
    if (decoyOn) {
      return lang === "zh"
        ? "高对抗末制导：目标抛射红外诱饵与雷达箔条，IMM-UKF 抗干扰波门已稳定锁定真目标。"
        : "ECM endgame: target deploys flares & chaff; IMM-UKF gating holds lock on true target.";
    }
    return lang === "zh"
      ? "双模导引头截获：X 波段脉冲多普勒雷达 + MWIR 红外联合锁定 F-35A，进入末段追踪。"
      : "Dual-mode lock: X-band radar + MWIR seeker track F-35A through terminal homing.";
  }
  return lang === "zh"
    ? `临近空间高超巡航：30 km 高空 Ma 9 飞行，由天基预警与数据链引导（距目标 ${rangeKm.toFixed(0)} km，末段 25 km 开启导引头）。`
    : `Near-space cruise at 30 km / Mach 9 on SBIRS datalink (${rangeKm.toFixed(0)} km out; seeker activates inside 25 km).`;
}

export function TelemetryPanel() {
  const t = useT();
  const lang = useApp((s) => s.lang);
  const telemetry = useApp((s) => s.telemetry);
  const status = useApp((s) => s.dataStatus);
  const dataTime = useApp((s) => s.dataTime);
  const xrayOpen = useApp((s) => s.xrayOpen);
  const [showMore, setShowMore] = useState(false);

  if (status !== "ready" || !telemetry) {
    return (
      <section className="group">
        <h3>{t("telemetry")}</h3>
        <p className="hint">{status === "error" ? t("telemetryError") : t("telemetryLoading")}</p>
      </section>
    );
  }

  const sample = sampleAt(dataTime);
  if (!sample) return null;
  const fins = sample.finDeflectionsRad;
  const deg = (rad: number) => ((rad * 180) / Math.PI).toFixed(1);
  const cg = sample.cgPos ?? 4.2;
  const cp = sample.cpPos ?? 4.9;
  const sm = cp - cg;
  const decoyOn = (sample.decoyActive ?? 0) > 0.5;
  const unstartOn = (sample.unstartFlag ?? 0) > 0.5;
  const story = phaseNarrative(sample.t, telemetry.end, sample.rangeM / 1000, sample.seekerLock, decoyOn, lang);

  return (
    <>
      <section className="group">
        <div className="mission-clock">
          <b>{formatMissionTime(dataTime)}</b>
          <span className={`lock-pill ${sample.seekerLock ? "is-lock" : ""}`}>
            {sample.seekerLock ? `LOCK ${Math.round(sample.fovDeg)}°` : "DATALINK"}
          </span>
        </div>

        {/* Layperson-friendly live stage explanation */}
        <p className="phase-story">{story}</p>

        {/* Clean non-intrusive X-Ray 3D vector color legend (zero clutter on missile!) */}
        {xrayOpen && (
          <div className="xray-legend" role="note">
            <span><i style={{ background: "#4df0a8" }} />{lang === "zh" ? "升力" : "Lift"}</span>
            <span><i style={{ background: "#ff6d59" }} />{lang === "zh" ? "阻力" : "Drag"}</span>
            <span><i style={{ background: "#ffcb5c" }} />{lang === "zh" ? "推力" : "Thrust"}</span>
            <span><i style={{ background: "#ff66d9" }} />{lang === "zh" ? "尾舵NMP" : "Fin NMP"}</span>
            <span><i style={{ background: "#ffcc4d" }} />CG {cg.toFixed(2)}m</span>
            <span><i style={{ background: "#4fd8ff" }} />CP {cp.toFixed(2)}m</span>
          </div>
        )}

        <div className="tel-kpi-grid">
          <div className="tel-kpi"><span>{t("mach")}</span><strong>Ma {sample.mach.toFixed(2)}</strong></div>
          <div className="tel-kpi"><span>{t("altitude")}</span><strong>{(sample.altM / 1000).toFixed(1)} km</strong></div>
          <div className="tel-kpi"><span>{t("range")}</span><strong>{(sample.rangeM / 1000).toFixed(1)} km</strong></div>
          <div className="tel-kpi"><span>{t("load")}</span><strong>{sample.loadG.toFixed(1)} g</strong></div>
        </div>
        <button
          type="button"
          className="sim-adv-toggle"
          onClick={() => setShowMore((v) => !v)}
          aria-expanded={showMore}
        >
          <span>{lang === "zh" ? "专业遥测（动压 / 气动热 / SNR / 稳态 / IMM）" : "Expert Telemetry (q / TPS / SNR / CG-CP / IMM)"}</span>
          <span>{showMore ? "▴" : "▾"}</span>
        </button>
        {showMore && (
          <dl className="kv kv--compact" style={{ marginTop: 8 }}>
            <dt>{t("speed")}</dt>
            <dd>{sample.speedMS.toFixed(0)} m/s</dd>
            <dt>{t("dynPressure")}</dt>
            <dd>{(sample.qPa / 1000).toFixed(1)} kPa</dd>
            <dt>{lang === "zh" ? "驻点热流 q̇s" : "Heat Flux"}</dt>
            <dd>{(sample.heatFluxMWm2 ?? 0).toFixed(2)} MW/m²</dd>
            <dt>{lang === "zh" ? "瞬态 / 平衡壁温" : "Tw / Teq"}</dt>
            <dd>{(sample.wallTempK ?? 288).toFixed(0)} / {(sample.wallTempEqK ?? sample.wallTempK ?? 288).toFixed(0)} K</dd>
            <dt>{lang === "zh" ? "双模 SNR" : "Dual SNR"}</dt>
            <dd>R {(sample.radarSnrDb ?? -60).toFixed(1)} · I {(sample.irSnrDb ?? -60).toFixed(1)} dB</dd>
            <dt>{lang === "zh" ? "静稳定裕度" : "Static Margin"}</dt>
            <dd>+{sm.toFixed(2)} m (CG {cg.toFixed(2)})</dd>
            <dt>{t("seekerFov")}</dt>
            <dd>{sample.fovDeg.toFixed(1)}°</dd>
            <dt>{t("mass")}</dt>
            <dd>{sample.massKg.toFixed(0)} kg</dd>
            {fins && (
              <>
                <dt>{t("fins")}</dt>
                <dd>
                  {deg(fins.up)}/{deg(fins.down)}/{deg(fins.left)}/{deg(fins.right)}°
                </dd>
              </>
            )}
            <dt>{lang === "zh" ? "IMM 权重" : "IMM Filter"}</dt>
            <dd>
              CV {((sample.immPCv ?? 0.34) * 100).toFixed(0)} / CA {((sample.immPCa ?? 0.33) * 100).toFixed(0)} / CT {((sample.immPCt ?? 0.33) * 100).toFixed(0)}%
            </dd>
            <dt>{lang === "zh" ? "对抗 / 进气" : "ECM / Inlet"}</dt>
            <dd>
              {decoyOn ? (lang === "zh" ? "诱饵已剔除" : "Decoy Gated") : (lang === "zh" ? "无干扰" : "Clear")}
              {" · "}
              {unstartOn ? "⚠ UNSTART" : (lang === "zh" ? "正常起动" : "Started")}
            </dd>
          </dl>
        )}
      </section>

      <section className="group">
        <h3>{t("events")}</h3>
        <div className="event-list">
          {telemetry.events.map((e: FlightEvent) => (
            <button
              key={e.id}
              type="button"
              className={`event-row ${dataTime >= e.t - 0.01 ? "is-passed" : ""}`}
              onClick={() => seekDataTime(e.t)}
              title={e.description}
            >
              <span className={`event-row__dot event-row__dot--${e.severity}`} />
              <span className="event-row__label">{t(EVENT_KEY[e.kind] ?? "eventPhase")}</span>
              <span className="event-row__time">{formatMissionTime(e.t)}</span>
            </button>
          ))}
        </div>
      </section>
    </>
  );
}
