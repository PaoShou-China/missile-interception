import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const SHOTS = path.resolve(process.cwd(), "test-results/visual");
fs.mkdirSync(SHOTS, { recursive: true });

/** Force English and open the explorer route. */
async function gotoExplore(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("av.lang", "en"));
  await page.goto("/#/explore");
}

test("academic home renders and links to the explorer", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("av.lang", "en"));
  await page.goto("/");
  await expect(page.locator(".site-header")).toBeVisible();
  await expect(page.locator(".hero h1")).toContainText("solved trajectory");
  await expect(page.locator(".site-nav a.is-active")).toHaveText("Home");
  await expect(page.locator(".stat-strip")).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, "00-academic-home.png"), fullPage: true });

  await page.locator(".site-header__actions a.btn--primary").click();
  await expect(page).toHaveURL(/#\/explore$/);
});

test("language switch translates the academic site and persists", async ({ page }) => {
  await page.goto("/");
  // Start from a known language without an init script (which would re-run on
  // reload and mask the persistence check).
  await page.evaluate(() => window.localStorage.setItem("av.lang", "en"));
  await page.reload();
  await expect(page.locator(".site-nav a").first()).toHaveText("Home");

  await page.locator(".lang-switch button", { hasText: "中" }).click();
  await expect(page.locator(".site-nav a").first()).toHaveText("首页");
  await expect(page.locator(".hero__actions a").first()).toContainText("打开三维探索器");
  expect(await page.evaluate(() => document.documentElement.lang)).toBe("zh-CN");

  await page.reload();
  await expect(page.locator(".site-nav a").first()).toHaveText("首页");
});

test("route metadata updates title, description and canonical URL", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("av.lang", "en"));
  await page.goto("/");
  await expect(page).toHaveTitle(/Home · Aerospace Vision/);
  const homeDesc = await page.locator('meta[name="description"]').getAttribute("content");
  expect(homeDesc ?? "").toContain("WGS84");

  await page.goto("/#/methodology");
  await expect(page).toHaveTitle(/Method · Aerospace Vision/);
  const desc = await page.locator('meta[name="description"]').getAttribute("content");
  expect(desc ?? "").toContain("telemetry");
  const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
  expect(canonical).toContain("#/methodology");
});

test("mobile explorer exposes mission and telemetry tabs", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoExplore(page);
  await expect(page.locator(".mobile-tabs")).toBeVisible({ timeout: 45_000 });

  await page.getByRole("tab", { name: "Mission" }).click();
  await expect(page.locator(".rail--left")).toBeVisible();
  await expect(page.locator(".rail--right")).toBeHidden();

  await page.getByRole("tab", { name: "Telemetry" }).click();
  await expect(page.locator(".rail--right")).toBeVisible();
  await expect(page.locator(".rail--left")).toBeHidden();
  await page.screenshot({ path: path.join(SHOTS, "10-mobile-telemetry.png") });
});

test("comparison studio loads real Run A and states the missing Run B", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("av.lang", "en"));
  await page.goto("/#/compare");
  await expect(page.locator("h1")).toHaveText("Algorithm Comparison Studio", { timeout: 45_000 });
  await expect(page.locator(".cmp-level")).toContainText("Not directly comparable");
  await expect(page.locator(".cmp-runs .cmp-run-card")).toHaveCount(2);
  await expect(page.locator(".cmp-run-card").nth(1)).toContainText("Awaiting comparable experiment");
  await expect(page.locator(".cmp-empty").first()).toBeVisible();
  await expect(page.locator("canvas")).toHaveCount(1);
  await page.screenshot({ path: path.join(SHOTS, "13-compare-awaiting-b.png"), fullPage: true });
});

test("comparison modes, synthetic demo, playback and language preservation", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("av.lang", "en"));
  await page.goto("/#/compare");
  await expect(page.locator(".cmp-toolbar").first()).toBeVisible({ timeout: 45_000 });

  // No B: overlay shows A only, slider shows the import state, statistics show A curves.
  await page.getByRole("tab", { name: "Overlay" }).click();
  await expect(page.locator(".cmp-overlay-stage canvas")).toHaveCount(1);
  await expect(page.locator(".cmp-legend")).toContainText("Run A only");
  await page.getByRole("tab", { name: "Before / After" }).click();
  await expect(page.locator(".cmp-empty--wide")).toBeVisible();
  await page.getByRole("tab", { name: "Statistics" }).click();
  await expect(page.locator(".cmp-chart-grid .chart-card")).toHaveCount(4);

  // Load the explicitly labelled synthetic demo so every mode can be exercised.
  await page.getByRole("button", { name: /synthetic demo/i }).first().click();
  await expect(page.locator(".callout--warn")).toContainText("synthetic data");
  await expect(page.locator(".cmp-run-card").nth(1)).toContainText("Synthetic UI demo");
  await page.getByRole("tab", { name: "Side-by-side" }).click();
  await expect(page.locator(".cmp-split canvas")).toHaveCount(2);
  await page.getByRole("tab", { name: "Overlay" }).click();
  await expect(page.locator(".cmp-legend")).toContainText("B · Proposed");
  await page.getByRole("tab", { name: "Before / After" }).click();
  await expect(page.locator(".cmp-slider-input")).toBeVisible();
  await page.getByRole("tab", { name: "Statistics" }).click();
  await expect(page.locator(".cmp-chart-grid .chart-card")).toHaveCount(7);

  // Comparison clock advances and pauses.
  const now = page.locator(".cmp-track-labels b");
  const before = await now.textContent();
  await page.locator(".cmp-play").click();
  await page.waitForTimeout(900);
  expect(await now.textContent()).not.toBe(before);
  await page.locator(".cmp-play").click();

  // Language switch must not reset the loaded B run or the time axis.
  await page.locator(".lang-switch button", { hasText: "中" }).click();
  await expect(page.locator("h1")).toHaveText("算法对比实验室");
  await expect(page.locator(".cmp-run-card").nth(1)).toContainText("合成 UI 演示");
  await page.screenshot({ path: path.join(SHOTS, "14-compare-synthetic-zh.png"), fullPage: true });
});

test("legacy reports stay reachable at their original paths", async ({ page }) => {
  const paths = [
    "/missile-intercept-overview/missile-intercept-overview.html",
    "/intercept-report/intercept-report.html",
    "/test-report/missile_interceptor_test_report.html",
    "/legacy/index.html",
  ];
  for (const p of paths) {
    const res = await page.request.get(p);
    expect(res.status(), `${p} should be served`).toBe(200);
  }
});

test("loads the validated scenario and renders the 3D scene", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));

  await gotoExplore(page);
  await expect(page.locator(".status-pill--ok")).toContainText("Telemetry verified", { timeout: 45_000 });
  await expect(page.locator(".loading")).toHaveCount(0);

  const canvas = page.locator("canvas[data-engine]").first();
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(1200);
  expect(box?.height ?? 0).toBeGreaterThan(700);
  await page.waitForTimeout(2500);

  await expect(page.locator(".mission-panel")).toBeVisible();
  await expect(page.locator(".telemetry-panel")).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, "01-earth-overview.png") });
  expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
});

test("timeline playback advances the single simulation clock and telemetry", async ({ page }) => {
  await gotoExplore(page);
  await expect(page.locator(".telemetry-panel")).toBeVisible({ timeout: 45_000 });

  const clock = page.locator(".timeline__now");
  const before = await clock.textContent();
  const altitudeBefore = await page.locator(".live-value").first().locator("strong").textContent();

  await page.locator(".transport--play").click();
  await page.waitForTimeout(2200);
  const after = await clock.textContent();
  expect(after).not.toBe(before);

  const altitudeAfter = await page.locator(".live-value").first().locator("strong").textContent();
  expect(altitudeAfter).not.toBe(altitudeBefore);

  await page.locator(".transport--play").click();
  await page.waitForTimeout(400);
  const paused = await clock.textContent();
  await page.waitForTimeout(700);
  expect(await clock.textContent()).toBe(paused);
});

test("seeking to the intercept event updates the scene state", async ({ page }) => {
  await gotoExplore(page);
  await expect(page.locator(".mission-panel")).toBeVisible({ timeout: 45_000 });
  await page.locator(".event-row").filter({ hasText: "Intercept" }).last().click();
  await page.waitForTimeout(700);
  await expect(page.locator(".timeline__now")).toContainText("11:1");
  await expect(page.locator(".phase-badge")).toContainText("Terminal");
  await page.screenshot({ path: path.join(SHOTS, "02-intercept-terminal.png") });
});

test("all six camera modes switch, including body close-ups", async ({ page }) => {
  await gotoExplore(page);
  await expect(page.locator(".camera-dock")).toBeVisible({ timeout: 45_000 });

  const modes = ["Earth", "Chase", "Intercept", "Fin", "Engine", "Attitude"];
  for (const mode of modes) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    await expect(page.locator("button[data-camera].is-active")).toHaveText(mode);
  }

  await page.getByRole("button", { name: "Engine", exact: true }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(SHOTS, "07-camera-engine.png") });

  await page.getByRole("button", { name: "Fin", exact: true }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(SHOTS, "08-camera-fin.png") });

  await page.getByRole("button", { name: "Attitude", exact: true }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(SHOTS, "09-camera-attitude.png") });

  const track = page.locator(".camera-dock button", { hasText: "Track" });
  await expect(track).toHaveClass(/is-active/);
  // The software GL runner renders at a few FPS; Playwright's actionability
  // stability check can starve there. Dispatch the click on the DOM node so the
  // React handler is still exercised without waiting for frame stability.
  const toggleTrack = () => track.evaluate((el) => (el as HTMLElement).click());
  await toggleTrack();
  await expect(track).not.toHaveClass(/is-active/);
  await toggleTrack();
  await expect(track).toHaveClass(/is-active/);
});

test("dedicated charts presentation shows every series", async ({ page }) => {
  await gotoExplore(page);
  await expect(page.locator(".segmented"), "top bar").toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Charts" }).click();
  await expect(page.locator(".charts-view")).toBeVisible();
  await expect(page.locator(".charts-view .chart-card")).toHaveCount(8);
  await expect(page.locator(".charts-view")).toContainText("Attitude angles");
  await expect(page.locator(".charts-view")).toContainText("Four fin channels");
  await page.screenshot({ path: path.join(SHOTS, "12-charts-view.png") });
  await page.keyboard.press("Escape");
  await expect(page.locator(".charts-view")).toHaveCount(0);
  await expect(page.locator(".camera-dock")).toBeVisible();
});

test("cinematic mode runs the three-minute presentation and exits cleanly", async ({ page }) => {
  await gotoExplore(page);
  await expect(page.locator(".segmented"), "top bar").toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Cinematic" }).click();
  await expect(page.locator(".cinematic__caption h1")).toHaveText("Ignition");
  await expect(page.locator(".cinematic__progress")).toBeVisible();
  await expect(page.locator(".cinematic__clock")).toContainText("03:00");
  await page.waitForTimeout(1200);

  // Transport buttons must be clickable (the letterbox layer disables pointer
  // events by default, so the bar has to re-enable them).
  const play = page.locator(".cinematic__play");
  await expect(play).toHaveText("❚❚");
  await play.click();
  await expect(play).toHaveText("▶");
  await play.click();
  await expect(play).toHaveText("❚❚");

  await page.screenshot({ path: path.join(SHOTS, "04-cinematic-ignition.png") });

  // Scrub to the middle of the film with a real click on the progress bar;
  // the caption must follow the wall clock.
  const bar = page.locator(".cinematic__progress");
  const box = await bar.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width * 0.56, box!.y + box!.height / 2);
  await expect(page.locator(".cinematic__caption h1")).toHaveText("Midcourse");

  await page.locator(".cinematic__exit").click();
  await expect(page.locator(".mission-panel")).toBeVisible();
});

test("measures animation frame rate over two seconds", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Hardware FPS gate is measured on Chromium only");
  await gotoExplore(page);
  await expect(page.locator(".telemetry-panel")).toBeVisible({ timeout: 45_000 });
  await page.locator(".transport--play").click();
  await page.waitForTimeout(1200);
  const renderer = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return ext ? String(gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "unknown";
  });
  const fps = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let frames = 0;
        const start = performance.now();
        const loop = () => {
          frames++;
          if (performance.now() - start < 2000) requestAnimationFrame(loop);
          else resolve((frames / (performance.now() - start)) * 1000);
        };
        requestAnimationFrame(loop);
      }),
  );
  console.log(`renderer: ${renderer}`);
  console.log(`measured FPS: ${fps.toFixed(1)}`);

  // CI runners and headless fallbacks may use SwiftShader/llvmpipe software
  // rasterisation. Record the number as evidence but do not treat it as a
  // hardware performance verdict; real-GPU runs must clear the 20 FPS floor.
  const software = /swiftshader|llvmpipe|software|mesa offscreen/i.test(renderer);
  if (software) {
    testInfo.annotations.push({
      type: "performance",
      description: `software renderer (${renderer}) measured ${fps.toFixed(1)} FPS; hardware target not evaluated`,
    });
    expect(fps).toBeGreaterThan(2);
  } else {
    expect(fps).toBeGreaterThan(20);
  }
});
