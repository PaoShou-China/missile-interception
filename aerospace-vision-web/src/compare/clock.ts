/** Independent comparison clock: never reuses the explorer's SimulationClock. */
export const compareClock = {
  timeA: 0,
  timeB: 0,
  start: 0,
  end: 1,
  rate: 20,
  playing: false,
};

export function setCompareRange(start: number, end: number) {
  compareClock.start = start;
  compareClock.end = end;
  compareClock.timeA = start;
  compareClock.timeB = start;
}

export function seekCompare(value: number, run: "A" | "B", sync: boolean) {
  const v = Math.min(compareClock.end, Math.max(compareClock.start, value));
  if (sync) {
    compareClock.timeA = v;
    compareClock.timeB = v;
  } else if (run === "A") {
    compareClock.timeA = v;
  } else {
    compareClock.timeB = v;
  }
}
