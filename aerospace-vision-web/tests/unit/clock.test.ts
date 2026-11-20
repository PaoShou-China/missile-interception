import { describe, expect, it } from "vitest";
import { SimulationClock } from "../../src/scientific/clock";

describe("SimulationClock", () => {
  it("starts paused at the beginning", () => {
    const c = new SimulationClock(0, 100);
    expect(c.time).toBe(0);
    expect(c.playing).toBe(false);
    c.tick(1);
    expect(c.time).toBe(0);
  });

  it("advances by wall time * rate", () => {
    const c = new SimulationClock(0, 100);
    c.setRate(20);
    c.play();
    c.tick(0.2);
    expect(c.time).toBeCloseTo(4, 9);
    expect(c.playing).toBe(true);
  });

  it("clamps at the end and stops", () => {
    const c = new SimulationClock(0, 10);
    c.setRate(100);
    c.play();
    c.tick(1);
    expect(c.time).toBe(10);
    expect(c.playing).toBe(false);
  });

  it("seeks within bounds and reports progress", () => {
    const c = new SimulationClock(100, 200);
    c.seek(150);
    expect(c.progress).toBeCloseTo(0.5, 12);
    c.seek(-1000);
    expect(c.time).toBe(100);
    c.seekFraction(2);
    expect(c.time).toBe(200);
  });

  it("steps one frame and pauses", () => {
    const c = new SimulationClock(0, 100);
    c.play();
    c.step(0.5);
    expect(c.time).toBe(0.5);
    expect(c.playing).toBe(false);
  });

  it("replays from the start when play is pressed at the end", () => {
    const c = new SimulationClock(0, 10);
    c.seek(10);
    c.play();
    expect(c.time).toBe(0);
    expect(c.playing).toBe(true);
  });

  it("clamps the playback rate", () => {
    const c = new SimulationClock(0, 10);
    c.setRate(1e9);
    expect(c.rate).toBeLessThanOrEqual(2000);
    c.setRate(-3);
    expect(c.rate).toBeGreaterThan(0);
  });
});
