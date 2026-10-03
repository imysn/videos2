import { useState } from "react";
import { useAuth } from "../../app/auth";
import { Notice } from "../../components/common";
import { LanguageSelect } from "../../i18n/LanguageSelect";
import { useI18n } from "../../i18n/provider";
export function LanguagePreference() {
  const { changeLocale, localeSaving: busy } = useAuth(),
    { t } = useI18n();
  const [error, setError] = useState<unknown>();
  return (
    <div>
      <LanguageSelect
        disabled={busy}
        onChange={(locale) => {
          setError(undefined);
          void changeLocale(locale).catch(setError);
        }}
      />
      {busy && <span role="status">{t("locale.saving")}</span>}
      <Notice error={error} />
    </div>
  );
}
