import { useEffect, useState } from "react";
import { useApp } from "../state";
import { useT } from "../i18n";

interface Still {
  file: string;
  time: string;
  view: string;
  label: string;
}
interface Manifest {
  generatedAt: string;
  stills: Still[];
  video?: string;
}

const BASE = `${import.meta.env.BASE_URL}renders/`;

export function GalleryOverlay() {
  const t = useT();
  const close = () => useApp.getState().setGalleryOpen(false);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${BASE}manifest.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((json: Manifest) => {
        if (!cancelled) setManifest(json);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="gallery">
      <div className="gallery__head">
        <div>
          <h2>{t("galleryTitle")}</h2>
          <p>{t("gallerySub")}</p>
        </div>
        <button type="button" className="ghost-btn" onClick={close}>
          {t("close")}
        </button>
      </div>

      {error && <div className="gallery__empty">{t("galleryEmpty")}</div>}

      {manifest && (
        <div className="gallery__body">
          <section>
            <h3>{t("galleryStills")}</h3>
            <div className="gallery__grid">
              {manifest.stills.map((s) => (
                <figure key={s.file} className="gallery__card">
                  <img src={`${BASE}${s.file}`} alt={s.label} loading="lazy" />
                  <figcaption>
                    <span>{s.label}</span>
                    <em>
                      {s.time} · {s.view}
                    </em>
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>

          {manifest.video && (
            <section>
              <h3>{t("galleryVideo")}</h3>
              <video className="gallery__video" src={`${BASE}${manifest.video}`} controls playsInline preload="metadata" />
            </section>
          )}

          <p className="gallery__note">{t("galleryNote")}</p>
        </div>
      )}
    </div>
  );
}
