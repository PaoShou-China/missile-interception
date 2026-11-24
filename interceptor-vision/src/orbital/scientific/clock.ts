/**
 * Single simulation clock. Every consumer (3D scene, HUD, charts, camera)
 * reads the same simulation time; none of them accumulates its own.
 */
export interface ClockState {
  time: number;
  start: number;
  end: number;
  rate: number;
  playing: boolean;
}

export class SimulationClock {
  start: number;
  end: number;
  private _time: number;
  private _rate = 1;
  private _playing = false;

  constructor(start = 0, end = 1) {
    if (!(end > start)) throw new Error("SimulationClock: end must be > start");
    this.start = start;
    this.end = end;
    this._time = start;
  }

  get time() {
    return this._time;
  }

  get rate() {
    return this._rate;
  }

  get playing() {
    return this._playing;
  }

  get progress() {
    return (this._time - this.start) / (this.end - this.start);
  }

  play() {
    if (this._time >= this.end) this._time = this.start;
    this._playing = true;
  }

  pause() {
    this._playing = false;
  }

  toggle() {
    if (this._playing) this.pause();
    else this.play();
  }

  setRate(rate: number) {
    this._rate = Math.max(0.01, Math.min(2000, rate));
  }

  seek(t: number) {
    this._time = Math.min(this.end, Math.max(this.start, t));
  }

  seekFraction(f: number) {
    this.seek(this.start + (this.end - this.start) * Math.min(1, Math.max(0, f)));
  }

  /** Advance by wall-clock seconds (already scaled by playback rate). */
  tick(dtWallSeconds: number): boolean {
    if (!this._playing) return false;
    const dt = Math.min(0.25, Math.max(0, dtWallSeconds)) * this._rate;
    this._time += dt;
    if (this._time >= this.end) {
      this._time = this.end;
      this._playing = false;
    }
    return true;
  }

  /** Step a single sample interval (frame stepping). */
  step(dt: number) {
    this.pause();
    this.seek(this._time + dt);
  }

  reset() {
    this._time = this.start;
    this._playing = false;
  }

  snapshot(): ClockState {
    return {
      time: this._time,
      start: this.start,
      end: this.end,
      rate: this._rate,
      playing: this._playing,
    };
  }
}
