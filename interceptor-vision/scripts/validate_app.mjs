import { chromium } from "playwright";
import fs from "node:fs";

const OUT = "C:\\Users\\13275\\AppData\\Local\\Temp\\iv-ui";
const URL = process.env.IV_URL || "http://localhost:4183/";
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 300));
});

const checks = [];
const check = (name, ok, detail = "") => checks.push({ name, ok, detail });

await page.goto(`${URL}?t=664.5&view=target`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__iv && window.__iv.store.getState().ready, null, { timeout: 120000 });
await page.waitForTimeout(5500);

const baseline = await page.evaluate(() => {
  const s = window.__iv.store.getState();
  const tel = s.telemetry;
  return {
    status: s.dataStatus,
    samples: tel?.samples.length,
    targets: tel?.targetSamples.length,
    events: tel?.events.length,
    metrics: tel?.metrics,
    start: tel?.start,
    end: tel?.end,
  };
});
check("baseline payload loaded", baseline.status === "ready" && baseline.samples === 1504, `${baseline.samples} samples`);

// Switch to the solver.
await page.locator(".sim-head .segmented button").nth(1).click();
await page.waitForTimeout(2000);

const inspect = () =>
  page.evaluate(() => {
    const s = window.__iv.store.getState();
    const tel = s.telemetry;
    const samples = tel?.samples ?? [];
    const targets = tel?.targetSamples ?? [];
    const lock = tel?.events.find((e) => e.kind === "lock")?.t ?? 0;
    let monotonic = true;
    let duplicates = 0;
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].t <= samples[i - 1].t) {
        monotonic = false;
        if (samples[i].t === samples[i - 1].t) duplicates++;
      }
    }
    const finite = samples.every((v) =>
      [v.latDeg, v.lonDeg, v.altM, v.speedMS, v.mach, v.qPa, v.loadG, v.rangeM, v.attitude.w].every(Number.isFinite),
    );
    const targetT = targets.map((t) => t.t);
    const eventsSorted = (tel?.events ?? []).every((e, i, a) => i === 0 || e.t >= a[i - 1].t);
    const phasesSorted = (tel?.phases ?? []).every((p, i, a) => i === 0 || p.startT >= a[i - 1].startT);
    const sampleMaxMach = Math.max(...samples.map((v) => v.mach));
    const sampleMaxQ = Math.max(...samples.map((v) => v.qPa));
    return {
      simActive: s.simActive,
      simMs: s.simMs,
      samples: samples.length,
      targets: targets.length,
      end: tel?.end,
      start: tel?.start,
      lastT: samples[samples.length - 1]?.t,
      lock,
      monotonic,
      duplicates,
      finite,
      eventsSorted,
      phasesSorted,
      targetCovers: targetT.length > 0 && targetT[0] <= lock + 1e-6 && targetT[targetT.length - 1] >= (tel?.end ?? 0) - 2.0,
      hasIntercept: (tel?.events ?? []).some((e) => e.kind === "intercept"),
      sampleMaxMach,
      sampleMaxQ,
      metrics: tel?.metrics,
    };
  });

const solved = await inspect();
check("solver active", solved.simActive === true, `${solved.simMs} ms`);
check("samples strictly increasing", solved.monotonic, `duplicates=${solved.duplicates}`);
check("no duplicate timestamps at merge", solved.duplicates === 0, `${solved.duplicates}`);
check("sample fields finite", solved.finite, "");
check("end equals last sample", Math.abs((solved.end ?? 0) - (solved.lastT ?? -1)) < 1e-6, `${solved.end}`);
check("intercept event present", solved.hasIntercept, "");
check("events sorted", solved.eventsSorted, "");
check("phases sorted", solved.phasesSorted, "");
check("target samples cover the solve", solved.targetCovers, `${solved.targets} samples`);
check("solved metrics finite", ["missDistanceM", "interceptTimeS", "maxLoadG", "downrangeKM"].every((k) => Number.isFinite(solved.metrics?.[k])), JSON.stringify(solved.metrics));
check("miss distance within 0..40 km", solved.metrics.missDistanceM >= 0 && solved.metrics.missDistanceM < 40000, `${solved.metrics.missDistanceM} m`);
check("intercept after lock", solved.metrics.interceptTimeS > solved.lock, `lock ${solved.lock} -> ${solved.metrics.interceptTimeS}`);
check("max Mach matches the samples", Math.abs(solved.metrics.maxMach - solved.sampleMaxMach) < 1e-3, `${solved.metrics.maxMach} vs ${solved.sampleMaxMach.toFixed(3)}`);
check("max dynamic pressure matches the samples", Math.abs(solved.metrics.maxDynamicPressurePa - solved.sampleMaxQ) < 1, `${solved.metrics.maxDynamicPressurePa} vs ${solved.sampleMaxQ.toFixed(0)}`);

await page.screenshot({ path: `${OUT}\\v-solved.png` });

// Parameter sweep through the UI store (the panel's debounced auto-solve runs).
const cases = [
  ["range 5 km", { rangeKm: 5 }],
  ["range 15 km", { rangeKm: 15 }],
  ["range 45 km", { rangeKm: 45 }],
  ["range 60 km", { rangeKm: 60 }],
  ["alt 5 km", { rangeKm: 25.1, altKm: 5 }],
  ["alt 30 km", { altKm: 30 }],
  ["alt 40 km", { altKm: 40 }],
  ["speed 500", { altKm: 14.8, speedMS: 500 }],
  ["speed 2000", { speedMS: 2000 }],
  ["speed 3000", { speedMS: 3000 }],
  ["heading 0", { speedMS: 434, headingDeg: 0 }],
  ["heading -90", { headingDeg: -90 }],
  ["heading 180", { headingDeg: 180 }],
  ["turn 3 g", { headingDeg: 90, maneuver: "turn", maneuverG: 3 }],
  ["weave 3 g", { maneuver: "weave", maneuverG: 3 }],
  ["N = 2", { maneuver: "none", navConst: 2 }],
  ["N = 6", { navConst: 6 }],
  ["max load 10 g", { navConst: 4, maxLoadG: 10 }],
];

const rows = [];
for (const [name, patch] of cases) {
  await page.evaluate((p) => window.__iv.store.getState().setSimParams(p), patch);
  await page.waitForTimeout(850);
  const r = await inspect();
  rows.push({
    name,
    miss: r.metrics?.missDistanceM,
    t: r.metrics?.interceptTimeS,
    load: r.metrics?.maxLoadG,
    ms: r.simMs,
    ok: Number.isFinite(r.metrics?.missDistanceM) && Number.isFinite(r.metrics?.interceptTimeS) && r.metrics.missDistanceM >= 0,
  });
}

check("all sweep cases produce finite metrics", rows.every((r) => r.ok), `${rows.filter((r) => !r.ok).length} bad`);
const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
check("longer range delays the intercept", byName["range 45 km"].t > byName["range 5 km"].t, `${byName["range 5 km"].t} -> ${byName["range 45 km"].t}`);
check("higher target speed changes the intercept", Math.abs(byName["speed 3000"].t - byName["speed 500"].t) > 0.2, `${byName["speed 500"].t} -> ${byName["speed 3000"].t}`);
check("N=6 no worse than N=2 on the default geometry", byName["N = 6"].miss <= byName["N = 2"].miss + 60, `${byName["N = 2"].miss} -> ${byName["N = 6"].miss} m`);
check("load limit is honoured in every solve", rows.every((r) => r.load <= 40.001), `max ${Math.max(...rows.map((r) => r.load ?? 0))} g`);
check("max-load 10 g case respects its own limit", byName["max load 10 g"].load <= 10.001, `${byName["max load 10 g"].load} g`);

await page.screenshot({ path: `${OUT}\\v-sweep.png` });

// Restore.
await page.locator(".sim-head .segmented button").nth(0).click();
await page.waitForTimeout(1200);
const restored = await page.evaluate(() => {
  const s = window.__iv.store.getState();
  return {
    simActive: s.simActive,
    samples: s.telemetry?.samples.length,
    t: s.dataTime,
    title: s.telemetry?.title,
    miss: s.telemetry?.metrics?.missDistanceM,
  };
});
check("restore returns the recorded payload", restored.simActive === false && restored.samples === 1504 && restored.miss === 26.7263, JSON.stringify(restored));

// Mobile layout.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(1200);
const mobile = await page.evaluate(() => {
  const tb = document.querySelector(".topbar");
  const rail = document.querySelector(".rail--left");
  return {
    topbarOverflow: tb.scrollWidth - tb.clientWidth,
    railScroll: rail ? rail.scrollHeight - rail.clientHeight : null,
  };
});
check("mobile top bar does not overflow", mobile.topbarOverflow <= 0, `${mobile.topbarOverflow}px`);
await page.screenshot({ path: `${OUT}\\v-mobile.png` });

check("no console/page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
console.log("\nsweep");
console.log("  case                miss(m)   t(s)      load(g)   solve(ms)");
for (const r of rows) {
  console.log(
    `  ${r.name.padEnd(18)} ${String(r.miss?.toFixed(1)).padStart(8)} ${String(r.t?.toFixed(2)).padStart(9)} ${String(r.load?.toFixed(2)).padStart(9)} ${String(r.ms).padStart(9)}`,
  );
}
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
fs.writeFileSync(`${OUT}\\validation.json`, JSON.stringify({ checks, rows, baseline, solved, restored, mobile }, null, 2));

await browser.close();
if (failed.length) process.exitCode = 1;
