import type { ReactNode } from "react";
import { useI18n } from "../i18n";
import { navigate, useRoute, type RoutePath } from "../app/router";

const LINKS: { path: RoutePath; key: string }[] = [
  { path: "/", key: "nav.home" },
  { path: "/methodology", key: "nav.methodology" },
  { path: "/results", key: "nav.results" },
  { path: "/verification", key: "nav.verification" },
  { path: "/resources", key: "nav.resources" },
  { path: "/compare", key: "nav.compare" },
];

function Brand() {
  const { t } = useI18n();
  return (
    <a className="site-brand" href="#/" onClick={() => navigate("/")}>
      <svg viewBox="0 0 40 40" width="30" height="30" aria-hidden>
        <circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.6" />
        <ellipse cx="20" cy="20" rx="16" ry="6" fill="none" stroke="currentColor" strokeWidth="1.1" opacity="0.55" transform="rotate(-28 20 20)" />
        <path d="M20 7 L25 20 L20 33 L15 20 Z" fill="none" stroke="currentColor" strokeWidth="1.1" opacity="0.9" />
        <circle cx="20" cy="20" r="2.6" fill="currentColor" />
      </svg>
      <span>
        <b>{t("brand.name")}</b>
        <i>{t("brand.latin")}</i>
      </span>
    </a>
  );
}

export function LangSwitch() {
  const { lang, setLang, t } = useI18n();
  return (
    <div className="lang-switch" role="group" aria-label={t("common.language")}>
      <button type="button" className={lang === "zh" ? "is-active" : ""} onClick={() => setLang("zh")}>中</button>
      <button type="button" className={lang === "en" ? "is-active" : ""} onClick={() => setLang("en")}>EN</button>
    </div>
  );
}

export function SiteLayout({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const route = useRoute();

  return (
    <div className="site">
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          // Hash routing owns the URL, so focus the landmark instead of
          // navigating to a nonexistent "#main" route.
          e.preventDefault();
          const main = document.getElementById("main");
          main?.focus();
          main?.scrollIntoView({ block: "start" });
        }}
      >
        {t("common.skip")}
      </a>
      <header className="site-header">
        <Brand />
        <nav className="site-nav" aria-label="Primary">
          {LINKS.map((l) => (
            <a
              key={l.path}
              href={`#${l.path}`}
              className={route === l.path ? "is-active" : ""}
            >
              {t(l.key)}
            </a>
          ))}
        </nav>
        <div className="site-header__actions">
          <LangSwitch />
          <a className="btn btn--primary btn--sm" href="#/explore">{t("nav.explore")}</a>
        </div>
      </header>

      <main className="site-main" id="main" tabIndex={-1}>{children}</main>

      <footer className="site-footer">
        <div>
          <b>{t("brand.name")}</b>
          <p>{t("brand.tagline")}</p>
        </div>
        <div className="site-footer__meta">
          <span>{t("common.stamp")} · {new Date().getFullYear()}</span>
          <a href="https://github.com/PaoShou-China/missile-interception" target="_blank" rel="noreferrer">
            PaoShou-China/missile-interception
          </a>
          <a href="#/resources">{t("nav.legacy")}</a>
        </div>
      </footer>
    </div>
  );
}
