import { test, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const SHOTS = path.resolve(process.cwd(), "test-results/visual");
fs.mkdirSync(SHOTS, { recursive: true });

test("academic home renders and links to the 3D explorer", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("av.lang", "en"));
  await page.goto("/");
  await expect(page.locator(".site-header")).toBeVisible();
  await expect(page.locator(".hero h1")).toContainText("solved trajectory");
  await expect(page.locator(".site-nav a.is-active")).toHaveText("Home");
  await expect(page.locator(".stat-strip")).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, "00-academic-home.png"), fullPage: true });

  await page.locator(".site-header__actions a.btn--primary").click();
  await expect(page).toHaveURL(/(#\/explore$|interceptor-vision\/)/);
});

test("language switch translates the academic site and persists", async ({ page }) => {
  await page.goto("/");
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

  await page.goto("/#/results");
  await expect(page).toHaveTitle(/Results · Aerospace Vision/);
  await expect(page.locator("main")).toBeVisible();
});

test("configuration studio loads registry options and real Run A", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("av.lang", "en"));
  await page.goto("/#/compare");
  await expect(page.locator("h1")).toHaveText("Experiment Configuration Studio", { timeout: 45_000 });

  await expect(page.locator(".cfg-card")).toHaveCount(2);
  await expect(page.locator(".cfg-card select")).toHaveCount(8);
  await expect(page.locator(".cfg-card--A select").nth(0)).toHaveValue("bezier-zem-apn");
  await expect(page.locator(".cfg-card--B select").nth(0)).toHaveValue("fixed-rate-bezier-zem-apn");
  await expect(page.locator(".cfg-card--B select").nth(1)).toHaveValue("classic-pid");
  await expect(page.locator(".cfg-card--A select").nth(3)).toHaveValue("campaign-paired-g0");
  await expect(page.locator(".cfg-card--B select").nth(3)).toHaveValue("campaign-paired-g0");

  const guidanceOptions = await page.locator(".cfg-card--A select").nth(0).locator("option").allTextContents();
  expect(guidanceOptions.length).toBeGreaterThanOrEqual(3);
  const controlOptions = await page.locator(".cfg-card--A select").nth(1).locator("option").allTextContents();
  expect(controlOptions.length).toBeGreaterThanOrEqual(3);

  await expect(page.locator(".cfg-profile")).toHaveCount(2);
  await expect(page.locator(".cfg-profile").first()).toContainText("8.11");

  await expect(page.locator(".callout--warn")).toHaveCount(0);
  await expect(page.locator(".cfg-card--A .cmp-tag")).toContainText("PASS");
  await expect(page.locator(".cmp-level--A")).toBeVisible();

  await expect(page.locator(".cmp-split canvas")).toHaveCount(2, { timeout: 45_000 });
  await expect(page.locator(".cmp-chart-grid .chart-card")).toHaveCount(7);

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

  await page.getByRole("button", { name: "Swap A / B" }).click();
  await expect(page.locator(".cfg-card--A select").nth(0)).toHaveValue("fixed-rate-bezier-zem-apn");
  await expect(page.locator(".cfg-card--B select").nth(0)).toHaveValue("bezier-zem-apn");
  await page.locator(".cfg-compare").click();
  await expect(page.locator(".cmp-split canvas")).toHaveCount(2);

  await page.getByRole("button", { name: "Save selection reference" }).click();
  await expect(page.locator(".cfg-toast")).toBeVisible();
  await expect(page.locator(".cfg-saved")).toBeVisible();

  await page.getByRole("button", { name: "Trajectory overlay" }).click();
  await expect(page.locator(".cmp-overlay-stage canvas")).toHaveCount(1);
  await expect(page.locator(".cmp-legend")).toContainText("A · Baseline");

  const now = page.locator(".cmp-track-labels b");
  const before = await now.textContent();
  await page.locator(".cmp-play").click();
  await page.waitForTimeout(900);
  expect(await now.textContent()).not.toBe(before);
  await page.locator(".cmp-play").click();

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

  await expect(page.locator(".cfg-card")).toHaveCount(2);
  const selectFont = await page.locator(".cfg-card--A select").first().evaluate(
    (el) => parseFloat(getComputedStyle(el).fontSize),
  );
  expect(selectFont).toBeGreaterThanOrEqual(14);
  const compareHeight = await page.locator(".cfg-compare").evaluate(
    (el) => el.getBoundingClientRect().height,
  );
  expect(compareHeight).toBeGreaterThanOrEqual(44);

  await expect(page.locator(".cmp-split canvas")).toHaveCount(2, { timeout: 45_000 });
  const paneBox = await page.locator(".cmp-pane").first().boundingBox();
  expect(paneBox?.height ?? 0).toBeGreaterThanOrEqual(240);

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

  await page.locator(".cfg-card--B select").nth(3).selectOption("coastal-intercept-demo");
  await expect(page.locator(".cfg-card--B .cfg-unavailable")).toBeVisible();
  await expect(page.locator(".cfg-compare")).toBeDisabled();

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

test("interceptor-vision 3D explorer renders new payload, X-Ray, SeekerOverlay and transport", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await page.goto("/interceptor-vision/?from=site");
  await expect(page.locator(".topbar")).toBeVisible({ timeout: 45_000 });
  await expect(page.locator(".topbar__kpi")).toBeVisible({ timeout: 45_000 });
  await expect(page.locator(".topbar__kpi")).toContainText("1.5 m");

  const canvas = page.locator("canvas").first();
  await expect(canvas).toBeVisible();

  // X-Ray physics toggle
  const xrayBtn = page.locator(".topbar__xray-btn");
  await expect(xrayBtn).toBeVisible();
  await xrayBtn.click();
  await expect(xrayBtn).toHaveClass(/is-active/);
  await xrayBtn.click();
  await expect(xrayBtn).not.toHaveClass(/is-active/);

  // Dual-mode SeekerOverlay opens with 4 sensor canvases and closes via Escape
  const seekerBtn = page.locator(".topbar__seeker-btn");
  await expect(seekerBtn).toBeVisible();
  await seekerBtn.click();
  await expect(page.locator(".seeker-grid")).toBeVisible();
  await expect(page.locator(".seeker-canvas")).toHaveCount(4);
  await page.screenshot({ path: path.join(SHOTS, "03-seeker-overlay.png") });
  await page.keyboard.press("Escape");
  await expect(page.locator(".seeker-grid")).toHaveCount(0);

  // Telemetry transport advances mission clock via useRef DOM update
  const clock = page.locator(".transport__labels b");
  await expect(clock).toBeVisible();
  const playBtn = page.locator(".transport__play");
  if ((await playBtn.textContent())?.trim() === "▶") {
    await playBtn.click();
  }
  const before = await clock.textContent();
  await page.waitForTimeout(1400);
  const after = await clock.textContent();
  expect(after).not.toBe(before);

  // 0.1x bullet-time jumps to terminal endgame
  await page.locator(".transport__right button", { hasText: "0.1×" }).click();
  await page.waitForTimeout(300);
  await expect(page.locator(".transport__rate")).toHaveText("0.1×");

  await page.screenshot({ path: path.join(SHOTS, "01-interceptor-vision.png") });
  expect(errors, `page errors: ${errors.join("\n")}`).toEqual([]);
});

test("interceptor-vision stays usable on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/interceptor-vision/?from=site");
  await expect(page.locator(".topbar")).toBeVisible({ timeout: 45_000 });
  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(pageOverflow).toBe(false);
});

test("measures animation frame rate on interceptor-vision", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Hardware FPS gate is measured on Chromium only");
  await page.goto("/interceptor-vision/?from=site");
  await expect(page.locator(".topbar__kpi")).toBeVisible({ timeout: 45_000 });
  await page.locator(".transport__play").click();
  await page.waitForTimeout(1000);
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

  const software = /swiftshader|llvmpipe|software|mesa offscreen/i.test(renderer);
  if (software) {
    testInfo.annotations.push({
      type: "performance",
      description: `software renderer (${renderer}) measured ${fps.toFixed(1)} FPS; hardware target not evaluated`,
    });
    expect(fps).toBeGreaterThan(1);
  } else {
    expect(fps).toBeGreaterThan(20);
  }
});
