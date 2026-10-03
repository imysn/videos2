export const SUPPORTED_LOCALES = ["es", "pl", "en"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "es";
export function isLocale(value: unknown): value is Locale {
  return SUPPORTED_LOCALES.some((locale) => locale === value);
}
export function accountLocale(
  role: "OWNER" | "PARTNER",
  saved: unknown,
): Locale {
  return isLocale(saved) ? saved : role === "PARTNER" ? "pl" : "es";
}
