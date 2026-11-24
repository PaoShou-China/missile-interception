// Visual QA + performance capture for the Interceptor Vision demo.
// Usage: node scripts/visual-check.mjs [baseUrl] [--ui-only]
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shots = path.join(root, "docs", "screenshots");
fs.mkdirSync(shots, { recursive: true });

const base = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "http://127.0.0.1:4176/";
const TIMES = ["day", "dusk", "night"];
const VIEWS = ["macro", "meso", "micro"];

const browser = await chromium.launch({
  channel: process.env.PW_CHANNEL || "msedge",
  headless: true,
  args: ["--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

const started = Date.now();
await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__iv && window.__iv.store.getState().ready, null, { timeout: 120000 });
const readyMs = Date.now() - started;
await page.waitForTimeout(2200);

const resources = await page.evaluate(() =>
  performance.getEntriesByType("resource")
    .filter((e) => /\.(glb|hdr|webp|jpg|png)(\?|$)/.test(e.name))
    .map((e) => ({ name: e.name.split("/").pop(), ms: Math.round(e.duration), bytes: e.transferSize || 0 })),
);

const hideUi = await page.addStyleTag({
  content: ".topbar,.rail,.rail-handle,.transport,.vignette{display:none!important}",
});

for (const time of TIMES) {
  for (const view of VIEWS) {
    await page.evaluate(({ time, view }) => {
      const s = window.__iv.store.getState();
      s.setTimeOfDay(time);
      s.setCameraMode(view);
      s.setPlaying(false);
      s.setGalleryOpen(false);
    }, { time, view });
    await page.waitForTimeout(view === "macro" ? 4500 : 3000);
    await page.screenshot({ path: path.join(shots, `${time}-${view}.png`) });
    console.log("shot", time, view);
  }
}

await hideUi.evaluate((el) => el.remove());
await page.evaluate(() => document.querySelectorAll("style").forEach((s) => s.remove()));
await page.evaluate(() => {
  const s = window.__iv.store.getState();
  s.setLang("zh");
  s.setCameraMode("meso");
  s.setTimeOfDay("day");
  s.setGalleryOpen(false);
});
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(shots, "ui-day-meso.png") });
await page.evaluate(() => window.__iv.store.getState().setTimeOfDay("dusk"));
await page.waitForTimeout(2200);
await page.screenshot({ path: path.join(shots, "ui-dusk-meso.png") });
await page.evaluate(() => window.__iv.store.getState().setTimeOfDay("night"));
await page.waitForTimeout(2200);
await page.screenshot({ path: path.join(shots, "ui-night-meso.png") });

// Gallery overlay (offline renders) if the manifest exists.
await page.evaluate(() => {
  const s = window.__iv.store.getState();
  s.setTimeOfDay("day");
  s.setGalleryOpen(true);
});
await page.waitForTimeout(1800);
await page.screenshot({ path: path.join(shots, "gallery.png") });
await page.evaluate(() => window.__iv.store.getState().setGalleryOpen(false));

// Frame-rate per quality tier, meso/day.
const perf = {};
for (const quality of ["performance", "balanced", "cinematic"]) {
  await page.evaluate((q) => {
    const s = window.__iv.store.getState();
    s.setGalleryOpen(false);
    s.setQuality(q);
    s.setCameraMode("meso");
    s.setTimeOfDay("day");
  }, quality);
  await page.waitForTimeout(2500);
  perf[quality] = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let frames = 0;
        const start = performance.now();
        const loop = () => {
          frames++;
          if (performance.now() - start < 2500) requestAnimationFrame(loop);
          else {
            const gl = window.__iv.gl;
            const ext = gl.getContext().getExtension("WEBGL_debug_renderer_info");
            resolve({
              fps: +((frames / (performance.now() - start)) * 1000).toFixed(1),
              renderer: ext ? gl.getContext().getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown",
            });
          }
        };
        requestAnimationFrame(loop);
      }),
  );
  console.log("perf", quality, perf[quality]);
}

const report = {
  capturedAt: new Date().toISOString(),
  readyMs,
  resources,
  perf,
  consoleErrors: errors,
};
fs.writeFileSync(path.join(root, "docs", "performance.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log("errors", errors.length);
await browser.close();
