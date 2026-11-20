/** Camera shot list for the automatic cinematic presentation. */
export interface CinematicShot {
  id: string;
  start: number;
  end: number;
  mode: "chase" | "launch" | "earth" | "target" | "top";
  kicker: string;
  title: string;
  caption: string;
  /** Camera distance multiplier used by the rig. */
  distance: number;
  /** Playback rate for this shot. (end-start)/rate = wall duration. */
  rate: number;
}

export const CINEMATIC_SHOTS: CinematicShot[] = [
  {
    id: "ignition",
    start: 0,
    end: 22,
    mode: "launch",
    kicker: "T+00:00",
    title: "Ignition",
    caption: "Lift-off from the inland launch site. Attitude is replayed from the validated 6-DoF state.",
    distance: 0.055,
    rate: 3.7,
  },
  {
    id: "boost",
    start: 22,
    end: 95,
    mode: "chase",
    kicker: "T+00:22",
    title: "Boost",
    caption: "Powered ascent. Position and attitude come directly from the telemetry stream — no scripted animation.",
    distance: 0.04,
    rate: 8.1,
  },
  {
    id: "midcourse",
    start: 95,
    end: 420,
    mode: "earth",
    kicker: "T+01:35",
    title: "Midcourse",
    caption: "Exo-atmospheric flight over the Earth-fixed frame. The trajectory is drawn at true scale.",
    distance: 1,
    rate: 16.3,
  },
  {
    id: "guidance",
    start: 420,
    end: 650,
    mode: "top",
    kicker: "T+07:00",
    title: "Guidance",
    caption: "Terminal geometry builds as the interceptor closes on the target datum.",
    distance: 1,
    rate: 16.4,
  },
  {
    id: "terminal",
    start: 650,
    end: 1e9,
    mode: "target",
    kicker: "T+10:50",
    title: "Terminal",
    caption: "Final seconds. Separation is shown at true scale; the ring marks the recorded intercept point.",
    distance: 0.5,
    rate: 2.7,
  },
];

export function shotAt(time: number): CinematicShot {
  for (let i = CINEMATIC_SHOTS.length - 1; i >= 0; i--) {
    if (time >= CINEMATIC_SHOTS[i].start) return CINEMATIC_SHOTS[i];
  }
  return CINEMATIC_SHOTS[0];
}
