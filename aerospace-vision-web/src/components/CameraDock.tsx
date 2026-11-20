import { useAppStore, type CameraMode } from "../state/store";

const MODES: { id: CameraMode; label: string; hint: string }[] = [
  { id: "earth", label: "Earth", hint: "Orbital overview" },
  { id: "chase", label: "Chase", hint: "Follow the interceptor" },
  { id: "top", label: "Plan", hint: "High plan view" },
  { id: "target", label: "Intercept", hint: "Frame both vehicles" },
  { id: "free", label: "Free", hint: "Free orbit camera" },
];

export function CameraDock() {
  const cameraMode = useAppStore((s) => s.cameraMode);
  const setCameraMode = useAppStore((s) => s.setCameraMode);

  return (
    <div className="camera-dock" role="group" aria-label="Camera">
      <span className="camera-dock__label">CAMERA</span>
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          className={cameraMode === m.id ? "is-active" : ""}
          onClick={() => setCameraMode(m.id)}
          title={m.hint}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
