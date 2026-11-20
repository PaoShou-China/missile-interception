/**
 * 1080p soak test: measures real animation FPS, JS heap and long-run stability
 * for 10 minutes of continuous playback (the scenario is replayed repeatedly).
 *
 * Usage (preview server must be running on :4173):
 *   node scripts/soak.mjs [--minutes 10] [--url http://127.0.0.1:4173/] [--out docs/performance]
 *
 * The browser is launched through the locally installed Edge channel when
 * PW_CHANNEL is set; otherwise the bundled Chromium is used.
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1] ?? "true"]);
    return acc;
  }, []),
);
const minutes = Number(args.minutes ?? 10);
const baseUrl = args.url ?? "http://127.0.0.1:4173/";
const url = baseUrl.includes("?") ? `${baseUrl}&qa=1` : `${baseUrl}?qa=1`;
const outDir = path.resolve(args.out ?? "docs/performance");
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: process.env.PW_CHANNEL || undefined,
  args: ["--ignore-gpu-blocklist", "--enable-precise-memory-info"],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

const started = Date.now();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForSelector(".status-pill--ok", { timeout: 90_000 });
await page.waitForSelector(".loading", { state: "detached", timeout: 90_000 });
const loadMs = Date.now() - started;

const renderer = await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const ext = gl?.getExtension("WEBGL_debug_renderer_info");
  return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "unknown";
});

await page.locator(".transport--play").click();
const samples = [];
const totalSamples = minutes * 6;
const intervalMs = 10_000;

for (let i = 0; i < totalSamples; i++) {
  const sample = await page.evaluate(
    async () => {
      const av = window.__av;
      if (av) {
        const s = av.store.getState();
        if (!s.playing) s.play();
      }
      const fps = await new Promise((resolve) => {
        let frames = 0;
        const start = performance.now();
        const loop = () => {
          frames++;
          if (performance.now() - start < 4000) requestAnimationFrame(loop);
          else resolve((frames / (performance.now() - start)) * 1000);
        };
        requestAnimationFrame(loop);
      });
      const mem = performance.memory
        ? {
            usedJSHeapMB: performance.memory.usedJSHeapSize / 1048576,
            totalJSHeapMB: performance.memory.totalJSHeapSize / 1048576,
          }
        : null;
      const time = av ? av.clock.time : null;
      return { fps, mem, time };
    },
  );
  samples.push({ t: i * (intervalMs / 1000), ...sample });
  const mins = ((i + 1) * intervalMs) / 60000;
  console.log(
    `[${mins.toFixed(1)} min] fps=${sample.fps.toFixed(1)} heap=${
      sample.mem ? sample.mem.usedJSHeapMB.toFixed(1) : "n/a"
    } MB sim=${sample.time?.toFixed(1)}`,
  );
  if (i < totalSamples - 1) await page.waitForTimeout(intervalMs - 4000);
}

await page.screenshot({ path: path.join(outDir, "soak-1080p.png") });
const fpsValues = samples.map((s) => s.fps).filter((v) => Number.isFinite(v));
const heaps = samples.map((s) => s.mem?.usedJSHeapMB).filter((v) => Number.isFinite(v));
const meanFps = fpsValues.reduce((a, b) => a + b, 0) / fpsValues.length;
const p95 = [...fpsValues].sort((a, b) => a - b)[Math.floor(fpsValues.length * 0.95)];
const heapStart = heaps[0];
const heapEnd = heaps[heaps.length - 1];
const summary = {
  url,
  renderer,
  viewport: "1920x1080",
  durationMin: minutes,
  loadMs,
  samples: samples.length,
  meanFps: +meanFps.toFixed(2),
  minFps: +Math.min(...fpsValues).toFixed(2),
  p95Fps: +p95.toFixed(2),
  heapStartMB: +heapStart?.toFixed(2),
  heapEndMB: +heapEnd?.toFixed(2),
  heapDeltaMB: +(heapEnd - heapStart).toFixed(2),
  errors,
  samplesDetail: samples,
};
fs.writeFileSync(path.join(outDir, "soak-1080p.json"), JSON.stringify(summary, null, 2));

const md = `# 1080p soak test

- Date: ${new Date().toISOString()}
- URL: ${url}
- Renderer: ${renderer}
- Viewport: 1920×1080, quality high (8K Earth + bloom)
- Duration: ${minutes} min continuous replay
- Initial load: ${(loadMs / 1000).toFixed(2)} s
- Mean FPS: **${meanFps.toFixed(1)}**
- Min / P95 FPS: ${Math.min(...fpsValues).toFixed(1)} / ${p95.toFixed(1)}
- JS heap: ${heapStart?.toFixed(1)} → ${heapEnd?.toFixed(1)} MB (Δ ${(heapEnd - heapStart).toFixed(1)} MB)
- Console errors: ${errors.length ? errors.join("; ") : "none"}

![soak](soak-1080p.png)
`;
fs.writeFileSync(path.join(outDir, "soak-1080p.md"), md);
console.log(JSON.stringify({ ...summary, samplesDetail: undefined }, null, 2));
await browser.close();
