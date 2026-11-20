import { useState } from "react";
import { useI18n } from "../i18n";

/** Provenance value with a copy-to-clipboard affordance. */
export function CopyValue({ value }: { value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked; the value stays visible and selectable.
    }
  };

  return (
    <span className="copy-value">
      <code>{value}</code>
      <button type="button" onClick={copy} aria-label={`${t("common.copy")}: ${value}`}>
        {copied ? t("common.copied") : t("common.copy")}
      </button>
    </span>
  );
}
