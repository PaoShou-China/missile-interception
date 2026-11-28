import { Suspense, lazy, useEffect } from "react";
import { I18nProvider, useI18n } from "../i18n";
import { useRoute, type RoutePath } from "./router";
import { SiteLayout } from "../pages/Layout";
import { HomePage } from "../pages/HomePage";
import { MethodologyPage } from "../pages/MethodologyPage";
import { VerificationPage } from "../pages/VerificationPage";
import { ResourcesPage } from "../pages/ResourcesPage";

// The explorer pulls in three.js/postprocessing; ECharts is only needed by the
// results page. Lazy-loading them keeps the academic reading pages light.
const ResultsPage = lazy(() => import("../pages/ResultsPage").then((m) => ({ default: m.ResultsPage })));
const ComparePage = lazy(() => import("../pages/ComparePage").then((m) => ({ default: m.ComparePage })));

const META: Record<RoutePath, { nav: string; desc: string }> = {
  "/": { nav: "nav.home", desc: "meta.description.home" },
  "/methodology": { nav: "nav.methodology", desc: "meta.description.methodology" },
  "/results": { nav: "nav.results", desc: "meta.description.results" },
  "/verification": { nav: "nav.verification", desc: "meta.description.verification" },
  "/resources": { nav: "nav.resources", desc: "meta.description.resources" },
  "/compare": { nav: "nav.compare", desc: "meta.description.compare" },
  "/explore": { nav: "explore.title", desc: "meta.description.explore" },
};

const BASE_URL = "https://paoshou-china.github.io/missile-interception/";

function upsertMeta(selector: string, attrs: Record<string, string>) {
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  if (!el) {
    el = document.createElement("meta");
    document.head.appendChild(el);
  }
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
}

/** Route-specific document title, description and social metadata. */
function RouteMeta({ route }: { route: RoutePath }) {
  const { t, lang } = useI18n();

  useEffect(() => {
    const meta = META[route];
    const title = `${t(meta.nav)} · ${t("brand.name")}`;
    const description = t(meta.desc);
    const url = `${BASE_URL}${route === "/" ? "" : `#${route}`}`;

    document.title = title;
    let desc = document.head.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (!desc) {
      desc = document.createElement("meta");
      desc.name = "description";
      document.head.appendChild(desc);
    }
    desc.content = description;

    upsertMeta('meta[property="og:title"]', { property: "og:title", content: title });
    upsertMeta('meta[property="og:description"]', { property: "og:description", content: description });
    upsertMeta('meta[property="og:url"]', { property: "og:url", content: url });
    upsertMeta('meta[property="og:locale"]', {
      property: "og:locale",
      content: lang === "zh" ? "zh_CN" : "en_US",
    });
    upsertMeta('meta[name="twitter:title"]', { name: "twitter:title", content: title });
    upsertMeta('meta[name="twitter:description"]', { name: "twitter:description", content: description });

    let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.rel = "canonical";
      document.head.appendChild(canonical);
    }
    canonical.href = url;
  }, [route, lang, t]);

  return null;
}

function RouteFallback() {
  const { t } = useI18n();
  return (
    <div className="route-fallback" role="status" aria-live="polite">
      <span className="route-fallback__mark" aria-hidden>◎</span>
      <p>{t("common.explorerLoading")}</p>
    </div>
  );
}

/** The "3D explorer" entry now hands over to the dedicated interceptor vision app. */
function ExploreRedirect() {
  const { t } = useI18n();

  useEffect(() => {
    // In dev the demo runs as its own Vite server; in a production build the
    // workflow stages it next to this app under /interceptor-vision/.
    const target = import.meta.env.DEV
      ? "http://127.0.0.1:4176/?from=site"
      : "./interceptor-vision/?from=site";
    window.location.replace(target);
  }, []);

  return (
    <div className="route-fallback" role="status" aria-live="polite">
      <span className="route-fallback__mark" aria-hidden>◎</span>
      <p>{t("common.explorerLoading")}</p>
    </div>
  );
}

export default function App() {
  const route = useRoute();

  if (route === "/explore") {
    return (
      <I18nProvider>
        <RouteMeta route={route} />
        <ExploreRedirect />
      </I18nProvider>
    );
  }

  return (
    <I18nProvider>
      <RouteMeta route={route} />
      <SiteLayout>
        {route === "/" && <HomePage />}
        {route === "/methodology" && <MethodologyPage />}
        {route === "/results" && (
          <Suspense fallback={<RouteFallback />}>
            <ResultsPage />
          </Suspense>
        )}
        {route === "/verification" && <VerificationPage />}
        {route === "/resources" && <ResourcesPage />}
        {route === "/compare" && (
          <Suspense fallback={<RouteFallback />}>
            <ComparePage />
          </Suspense>
        )}
      </SiteLayout>
    </I18nProvider>
  );
}
