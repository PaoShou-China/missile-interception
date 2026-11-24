/**
 * Minimal hash router. Hash routing keeps deep links working on GitHub Pages
 * project sites, where a path-based route would 404 on refresh.
 */
import { useEffect, useState } from "react";

export type RoutePath =
  | "/"
  | "/methodology"
  | "/results"
  | "/verification"
  | "/resources"
  | "/compare"
  | "/explore"
  | "/explore-legacy";

const ROUTES: RoutePath[] = [
  "/",
  "/methodology",
  "/results",
  "/verification",
  "/resources",
  "/compare",
  "/explore",
  "/explore-legacy",
];

export function parseHash(hash: string): RoutePath {
  const raw = hash.replace(/^#/, "");
  const path = raw.split("?")[0] || "/";
  const normalized = (path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path) as RoutePath;
  return ROUTES.includes(normalized) ? normalized : "/";
}

export function navigate(path: RoutePath) {
  if (typeof window === "undefined") return;
  window.location.hash = `#${path}`;
}

export function useRoute(): RoutePath {
  const [route, setRoute] = useState<RoutePath>(() =>
    typeof window === "undefined" ? "/" : parseHash(window.location.hash),
  );

  useEffect(() => {
    const onChange = () => {
      setRoute(parseHash(window.location.hash));
      window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  return route;
}
