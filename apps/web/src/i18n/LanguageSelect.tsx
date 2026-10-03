import { SUPPORTED_LOCALES, localeNames, isLocale } from "./index";
import { useI18n } from "./provider";
import type { Locale } from "./types";
export function LanguageSelect({
  onChange,
  disabled = false,
}: {
  onChange?: (locale: Locale) => void;
  disabled?: boolean;
}) {
  const { locale, setLocale, t } = useI18n();
  return (
    <label>
      {t("locale.label")}
      <select
        aria-label={t("locale.label")}
        value={locale}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          if (!isLocale(next)) return;
          if (onChange) onChange(next);
          else setLocale(next, true);
        }}
      >
        {SUPPORTED_LOCALES.map((code) => (
          <option key={code} value={code} lang={code}>
            {localeNames[code]}
          </option>
        ))}
      </select>
    </label>
  );
}
