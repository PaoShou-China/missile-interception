import { useAppStore } from "../state/store";

export function LoadingScreen() {
  const status = useAppStore((s) => s.status);
  const error = useAppStore((s) => s.error);
  if (status === "ready") return null;

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
            <p className="loading__stage">ACQUIRING TELEMETRY · VALIDATING WGS84 FRAMES</p>
            <div className="loading__bar"><span /></div>
            <p className="loading__hint">
              Positions are replayed in the Earth-fixed frame at true scale.
              Initial render may take a moment while the globe texture is decoded.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
