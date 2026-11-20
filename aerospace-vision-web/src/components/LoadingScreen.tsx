import { useProgress } from "@react-three/drei";
import { useAppStore } from "../state/store";

export function LoadingScreen() {
  const status = useAppStore((s) => s.status);
  const error = useAppStore((s) => s.error);
  const { progress } = useProgress();
  // Keep the curtain until both the scenario and the Earth textures are ready.
  const assetsPending = progress < 100;
  if (status === "ready" && !assetsPending) return null;

  return (
    <div className="loading">
      <div className="loading__grid" aria-hidden />
      <div className="loading__content">
        <div className="loading__brand">AEROSPACE VISION</div>
        <h1>Scientific trajectory visualisation</h1>
        {status === "error" ? (
          <>
            <p className="loading__error">Unable to initialise the scenario.</p>
            <pre>{error}</pre>
            <p className="loading__hint">
              Run <code>npm run data:build</code> to regenerate the scenario payload.
            </p>
          </>
        ) : (
          <>
            <p className="loading__stage">
              ACQUIRING TELEMETRY · VALIDATING WGS84 FRAMES
              {assetsPending ? ` · EARTH TEXTURES ${Math.round(progress)}%` : ""}
            </p>
            <div className="loading__bar"><span /></div>
            <p className="loading__hint">
              Positions are replayed in the Earth-fixed frame at true scale.
              High quality streams an 8K day map, so the first load can take a moment.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
