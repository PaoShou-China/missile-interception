import { test, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const SHOTS = path.resolve(process.cwd(), "test-results/visual");
fs.mkdirSync(SHOTS, { recursive: true });

test("loads the validated scenario and renders the 3D scene", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));

  await page.goto("/");
  await expect(page.locator(".status-pill--ok")).toContainText("TELEMETRY VERIFIED", { timeout: 45_000 });
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
  await page.goto("/");
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
  await page.goto("/");
  await expect(page.locator(".mission-panel")).toBeVisible({ timeout: 45_000 });
  await page.locator(".event-row").filter({ hasText: "INTERCEPT" }).click();
  await page.waitForTimeout(700);
  await expect(page.locator(".timeline__now")).toContainText("11:11");
  await expect(page.locator(".phase-badge")).toContainText("TERMINAL");
  await page.screenshot({ path: path.join(SHOTS, "02-intercept-terminal.png") });
});

test("camera modes switch and the chase view renders", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".camera-dock")).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Chase", exact: true }).click();
  await page.waitForTimeout(1600);
  await expect(page.locator("button[data-camera].is-active")).toHaveText("Chase");
  await page.screenshot({ path: path.join(SHOTS, "03-chase-camera.png") });

  await page.getByRole("button", { name: "Free", exact: true }).click();
  await expect(page.locator("button[data-camera].is-active")).toHaveText("Free");
  await page.getByRole("button", { name: "Earth", exact: true }).click();
  await expect(page.locator("button[data-camera].is-active")).toHaveText("Earth");

  const track = page.locator(".camera-dock button", { hasText: "Track" });
  await expect(track).toHaveClass(/is-active/);
  await track.click();
  await expect(track).not.toHaveClass(/is-active/);
  await track.click();
  await expect(track).toHaveClass(/is-active/);
});

test("cinematic mode runs a captioned shot sequence and exits cleanly", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".segmented"), "top bar").toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Cinematic" }).click();
  await expect(page.locator(".cinematic__caption h1")).toHaveText("Ignition");
  await expect(page.locator(".cinematic__progress")).toBeVisible();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(SHOTS, "04-cinematic-ignition.png") });

  await page.locator(".cinematic__exit").click();
  await expect(page.locator(".mission-panel")).toBeVisible();
});

test("measures animation frame rate over two seconds", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Hardware FPS gate is measured on Chromium only");
  await page.goto("/");
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

