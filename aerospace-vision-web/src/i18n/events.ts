/** Map source event labels to translation keys (unknown labels stay verbatim). */
const EVENT_KEYS: Record<string, string> = {
  LAUNCH: "event.launch",
  MIDCOURSE: "event.midcourse",
  APOGEE: "event.apogee",
  "SEEKER LOCK": "event.seeker_lock",
  TERMINAL: "event.terminal",
  "TERMINAL HANDOVER": "event.terminal_handover",
  INTERCEPT: "event.intercept",
};

export function eventKey(label: string): string | null {
  return EVENT_KEYS[label] ?? null;
}

export function eventLabel(t: (k: string) => string, label: string): string {
  const key = eventKey(label);
  return key ? t(key) : label;
}
