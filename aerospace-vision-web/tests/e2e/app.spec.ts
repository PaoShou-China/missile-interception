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

test("configuration studio loads registry options and real Run A", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("av.lang", "en"));
  await page.goto("/#/compare");
  await expect(page.locator("h1")).toHaveText("Experiment Configuration Studio", { timeout: 45_000 });

  // Two side-by-side panels, four dropdowns each, all sourced from the registry.
  await expect(page.locator(".cfg-card")).toHaveCount(2);
  await expect(page.locator(".cfg-card select")).toHaveCount(8);
  await expect(page.locator(".cfg-card--A select").nth(0)).toHaveValue("bezier-zem-apn");
  await expect(page.locator(".cfg-card--B select").nth(0)).toHaveValue("fixed-rate-bezier-zem-apn");
  await expect(page.locator(".cfg-card--B select").nth(1)).toHaveValue("classic-pid");
  await expect(page.locator(".cfg-card--A select").nth(3)).toHaveValue("campaign-paired-g0");
  await expect(page.locator(".cfg-card--B select").nth(3)).toHaveValue("campaign-paired-g0");

  // Three guidance laws and three attitude controllers are selectable.
  const guidanceOptions = await page.locator(".cfg-card--A select").nth(0).locator("option").allTextContents();
  expect(guidanceOptions.length).toBeGreaterThanOrEqual(3);
  const controlOptions = await page.locator(".cfg-card--A select").nth(1).locator("option").allTextContents();
  expect(controlOptions.length).toBeGreaterThanOrEqual(3);

  // Read-only vehicle profile is shown for both panels.
  await expect(page.locator(".cfg-profile")).toHaveCount(2);
  await expect(page.locator(".cfg-profile").first()).toContainText("8.11");

  // Both default runs are real and comparable; no synthetic banner.
  await expect(page.locator(".callout--warn")).toHaveCount(0);
  await expect(page.locator(".cfg-card--A .cmp-tag")).toContainText("PASS");
  await expect(page.locator(".cmp-level--A")).toBeVisible();

  // Side-by-side 3D stage renders one canvas per run.
  await expect(page.locator(".cmp-split canvas")).toHaveCount(2, { timeout: 45_000 });
  await expect(page.locator(".cmp-chart-grid .chart-card")).toHaveCount(7);

  // Campaign aggregate table carries A, B, unit, source and computed differences.
  await expect(page.locator(".cmp-campaign")).toContainText("Hit rate");
  await expect(page.locator(".cmp-campaign")).toContainText("N = 24 / 24");
  await expect(page.locator(".cmp-campaign .cmp-table")).toContainText("Source");
  await expect(page.locator(".cmp-campaign .cmp-table")).not.toContainText("N/A");

  await page.screenshot({ path: path.join(SHOTS, "13-config-studio.png"), fullPage: true });
});

test("compare, swap, save reference, overlay and playback", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("av.lang", "en"));
  await page.goto("/#/compare");
  await expect(page.locator(".cfg-compare")).toBeVisible({ timeout: 45_000 });

  // Swap A/B then compare: selections are exchanged.
  await page.getByRole("button", { name: "Swap A / B" }).click();
  await expect(page.locator(".cfg-card--A select").nth(0)).toHaveValue("fixed-rate-bezier-zem-apn");
  await expect(page.locator(".cfg-card--B select").nth(0)).toHaveValue("bezier-zem-apn");
  await page.locator(".cfg-compare").click();
  await expect(page.locator(".cmp-split canvas")).toHaveCount(2);

  // Save the selection reference locally.
  await page.getByRole("button", { name: "Save selection reference" }).click();
  await expect(page.locator(".cfg-toast")).toBeVisible();
  await expect(page.locator(".cfg-saved")).toBeVisible();

  // Overlay stage shares one camera and one clock.
  await page.getByRole("button", { name: "Trajectory overlay" }).click();
  await expect(page.locator(".cmp-overlay-stage canvas")).toHaveCount(1);
  await expect(page.locator(".cmp-legend")).toContainText("A · Baseline");

  // Comparison clock advances then pauses.
  const now = page.locator(".cmp-track-labels b");
  const before = await now.textContent();
  await page.locator(".cmp-play").click();
  await page.waitForTimeout(900);
  expect(await now.textContent()).not.toBe(before);
  await page.locator(".cmp-play").click();

  // Language switch keeps selections and loaded runs intact.
  await page.locator(".lang-switch button", { hasText: "中" }).click();
  await expect(page.locator("h1")).toHaveText("实验配置对比工作台");
  await expect(page.locator(".cfg-card--A select").nth(0)).toHaveValue("fixed-rate-bezier-zem-apn");
  await expect(page.locator(".cfg-card--B select").nth(0)).toHaveValue("bezier-zem-apn");
  await page.screenshot({ path: path.join(SHOTS, "14-config-studio-zh.png"), fullPage: true });
});

test("config studio stays readable on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => window.localStorage.setItem("av.lang", "en"));
  await page.goto("/#/compare");
  await expect(page.locator("h1")).toHaveText("Experiment Configuration Studio", { timeout: 45_000 });

  // Panels stack, controls are full width and the dropdown text is legible.
  await expect(page.locator(".cfg-card")).toHaveCount(2);
  const selectFont = await page.locator(".cfg-card--A select").first().evaluate(
    (el) => parseFloat(getComputedStyle(el).fontSize),
  );
  expect(selectFont).toBeGreaterThanOrEqual(14);
  const compareHeight = await page.locator(".cfg-compare").evaluate(
    (el) => el.getBoundingClientRect().height,
  );
  expect(compareHeight).toBeGreaterThanOrEqual(44);

  // Both A/B panes keep a usable height instead of being squeezed.
  await expect(page.locator(".cmp-split canvas")).toHaveCount(2, { timeout: 45_000 });
  const paneBox = await page.locator(".cmp-pane").first().boundingBox();
  expect(paneBox?.height ?? 0).toBeGreaterThanOrEqual(240);

  // Wide tables scroll inside their section rather than widening the page.
  const campaignScrolls = await page.locator(".cmp-campaign").evaluate(
    (el) => el.scrollWidth > el.clientWidth,
  );
  expect(campaignScrolls).toBe(true);
  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(pageOverflow).toBe(false);

  await page.screenshot({ path: path.join(SHOTS, "16-mobile-studio.png"), fullPage: true });
});

test("synthetic scenario is labelled and withholds differences", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("av.lang", "en"));
  await page.goto("/#/compare");
  await expect(page.locator(".cfg-compare")).toBeVisible({ timeout: 45_000 });

  // PIP + the demo scenario has no record: the UI must refuse to fabricate it.
  await page.locator(".cfg-card--B select").nth(3).selectOption("coastal-intercept-demo");
  await expect(page.locator(".cfg-card--B .cfg-unavailable")).toBeVisible();
  await expect(page.locator(".cfg-compare")).toBeDisabled();

  // The demo record exists only with the baseline guidance and controller.
  await page.locator(".cfg-card--B select").nth(0).selectOption("bezier-zem-apn");
  await page.locator(".cfg-card--B select").nth(1).selectOption("three-loop");
  await expect(page.locator(".cfg-compare")).toBeEnabled();
  await page.locator(".cfg-compare").click();

  await expect(page.locator(".callout--warn")).toContainText("synthetic data");
  await expect(page.locator(".cmp-level--C")).toBeVisible();
  await expect(page.locator(".cfg-card--B .cmp-tag")).toContainText("Synthetic");
  await expect(page.locator(".cmp-chart-grid .chart-card")).toHaveCount(4);
  await expect(page.locator(".cmp-table").first()).toContainText("N/A");
  await page.screenshot({ path: path.join(SHOTS, "15-config-studio-synthetic.png"), fullPage: true });
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
