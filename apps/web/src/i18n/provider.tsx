import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_LOCALE,
  isLocale,
  intlLocales,
  createTranslator,
  localizedLabel,
} from "./index";
import type { Locale } from "./types";
const STORAGE_KEY = "rave-locale";
export function preLoginLocale(
  saved: unknown,
  languages: readonly string[],
): Locale {
  if (isLocale(saved)) return saved;
  for (const language of languages) {
    const base = language.toLowerCase().split("-")[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}
function initialLocale() {
  let saved: unknown;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* Storage can be unavailable in private browsing. */
  }
  return preLoginLocale(saved, navigator.languages ?? [navigator.language]);
}
function useLocaleState() {
  const [locale, update] = useState<Locale>(initialLocale);
  // Account hydration does not overwrite an explicitly chosen pre-login language.
  const setLocale = useCallback((next: Locale, remember = false) => {
    update(next);
    if (remember)
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* UI still works without storage. */
      }
  }, []);
  const t = useMemo(() => createTranslator(locale), [locale]);
  const number = useCallback(
    (value: number, options?: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat(intlLocales[locale], options).format(value),
    [locale],
  );
  const date = useCallback(
    (value: string | Date, options?: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(intlLocales[locale], options).format(
        new Date(value),
      ),
    [locale],
  );
  const label = useCallback(
    (prefix: string, value: string) => localizedLabel(t, prefix, value),
    [t],
  );
  useLayoutEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return useMemo(
    () => ({ locale, setLocale, t, number, date, label }),
    [locale, setLocale, t, number, date, label],
  );
}
const Context = createContext<ReturnType<typeof useLocaleState> | null>(null);
export function I18nProvider({ children }: { children: ReactNode }) {
  const value = useLocaleState();
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useI18n() {
  const value = useContext(Context);
  if (!value) throw new Error("I18n provider required");
  return value;
}
