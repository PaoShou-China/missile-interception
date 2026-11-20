import { useEffect, useState } from "react";
import { loadScenarioCached } from "../scientific/scenario";
import type { ScenarioManifest } from "../scientific/types";

/** Manifest loader for the academic pages (cached, shared with the explorer). */
export function useManifest() {
  const [manifest, setManifest] = useState<ScenarioManifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadScenarioCached()
      .then((r) => { if (!cancelled) setManifest(r.manifest); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, []);

  return { manifest, error };
}
