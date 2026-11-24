/** Display formatting helpers (units are always rendered explicitly). */
export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${sec.toFixed(1).padStart(4, "0")}`;
  return `${String(m).padStart(2, "0")}:${sec.toFixed(1).padStart(4, "0")}`;
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `T+${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export function fmt(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtSigned(value: number, digits = 1): string {
  const s = fmt(Math.abs(value), digits);
  return value < 0 ? `−${s}` : s;
}

export function latLon(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? "N" : "S"}  ${Math.abs(lon).toFixed(3)}°${lon >= 0 ? "E" : "W"}`;
}

export function compactNumber(value: number): string {
  if (Math.abs(value) >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return value.toFixed(0);
}
