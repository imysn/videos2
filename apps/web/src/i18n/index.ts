import { es } from "./es";
import { pl } from "./pl";
import { en } from "./en";
import type { Catalog, Key, Locale, Translator } from "./types";
export {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  isLocale,
  accountLocale,
} from "../../../../packages/contracts/src/locale";
export const catalogs = { es, pl, en } satisfies Record<Locale, Catalog>;
export const intlLocales = { es: "es-ES", pl: "pl-PL", en: "en-GB" } as const;
// Autonyms are names of languages, deliberately independent of the active locale.
export const localeNames = {
  es: "Español",
  pl: "Polski",
  en: "English",
} as const;
type RuntimeMessage = string | Record<string, string>;
export function createTranslator(
  locale: Locale,
  catalog: Partial<Catalog> = catalogs[locale],
  report: (key: Key) => void = (key) => {
    if (import.meta.env?.DEV)
      console.warn(`Missing translation: ${locale}/${key}`);
  },
): Translator {
  const pluralRules = new Intl.PluralRules(intlLocales[locale]);
  const countFormat = new Intl.NumberFormat(intlLocales[locale]);
  const translate = (
    key: Key,
    values: Record<string, string | number> = {},
  ) => {
    let message: RuntimeMessage | undefined = catalog[key];
    const category = pluralRules.select(Number(values.count));
    let text =
      typeof message === "string"
        ? message
        : (message?.[category] ?? message?.other);
    if (!text?.trim()) {
      report(key);
      message = es[key];
      text =
        typeof message === "string"
          ? message
          : (message?.[category as keyof typeof message] ??
            message?.other ??
            es["error.generic"]);
    }
    return text.replace(/\{(\w+)\}/g, (token, name: string) => {
      const value = values[name];
      if (value === undefined) return token;
      return name === "count"
        ? countFormat.format(Number(value))
        : String(value);
    });
  };
  return translate as Translator;
}
const errorAliases: Record<string, Key> = {
  STALE_SESSION: "error.STALE_REVISION",
  STALE_CONTENT: "error.STALE_REVISION",
  STALE_HOST_EPOCH: "error.STALE_REVISION",
  LEASE_REVOKED: "error.DEVICE_ACTIVE",
  STALE_SOLO_SESSION: "error.SOLO_DEVICE_ACTIVE",
  SOURCE_UNAVAILABLE: "error.MEDIA_UNAVAILABLE",
  SOURCE_SEGMENT_UNAVAILABLE: "error.MEDIA_UNAVAILABLE",
  CONTENT_GENERATION_MISMATCH: "error.CONTENT_IDENTITY_MISMATCH",
  COPY_SIZE_MISMATCH: "error.CONTENT_IDENTITY_MISMATCH",
  INVALID_PAYLOAD: "error.INVALID_REQUEST",
  INVALID_RANGE: "error.INVALID_REQUEST",
  INVALID_POSITION: "error.INVALID_REQUEST",
  INVALID_CURSOR: "error.INVALID_REQUEST",
  INVALID_CHUNK: "error.INVALID_REQUEST",
  INVALID_ASSET: "error.INVALID_REQUEST",
  CONTENT_TYPE_REQUIRED: "error.INVALID_REQUEST",
  IDEMPOTENCY_CONFLICT: "error.STALE_REVISION",
  CSRF_REJECTED: "error.AUTH_REQUIRED",
  ORIGIN_REJECTED: "error.FORBIDDEN",
  INVALID_OAUTH_CODE: "error.INVALID_OAUTH_STATE",
  STREAM_LIMIT: "error.RATE_LIMITED",
  INSPECTION_LIMIT: "error.RATE_LIMITED",
  MEDIA_CORRUPT: "error.PROCESSING_ERROR",
  INVALID_OUTPUT: "error.PROCESSING_ERROR",
  FILE_SOURCE_REQUIRED: "error.SOURCE_UNSUPPORTED",
  LOCAL_SOURCE_REQUIRED: "error.SOURCE_UNSUPPORTED",
  URL_SOURCE_REQUIRED: "error.SOURCE_UNSUPPORTED",
  UNSAFE_HEADERS: "error.SSRF_REJECTED",
  INVALID_STORAGE_KEY: "error.NOT_FOUND",
  INVALID_JOB: "error.NOT_FOUND",
  UNSUPPORTED_JOB: "error.PROCESSING_ERROR",
  UPLOAD_COMPLETED: "error.UPLOAD_UNAVAILABLE",
  KEY_ROTATION_PENDING: "error.MAINTENANCE",
  ROOM_INSTANCE_EXISTS: "error.STALE_REVISION",
  ROOM_NOT_INITIALIZED: "error.MAINTENANCE",
  ENOSPC: "error.INSUFFICIENT_STORAGE",
};
export function localizedLabel(
  t: Translator,
  prefix: string,
  value: string,
  fallback: Key = "source.unknown",
) {
  const key = `${prefix}.${value}`;
  return t(Object.hasOwn(es, key) ? (key as Key) : fallback);
}
export function errorText(t: Translator, error: unknown) {
  const code =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : error instanceof Error
        ? error.message
        : "INTERNAL_ERROR";
  return errorAliases[code]
    ? t(errorAliases[code])
    : localizedLabel(t, "error", code, "error.generic");
}
export function catalogIssues(
  candidate: unknown,
  reference: unknown = es,
  path = "",
): string[] {
  if (typeof reference === "string") {
    if (typeof candidate !== "string" || !candidate.trim()) return [path];
    const placeholders = (text: string) =>
      [...text.matchAll(/\{(\w+)\}/g)]
        .map((m) => m[1])
        .sort()
        .join(",");
    return placeholders(candidate) === placeholders(reference) ? [] : [path];
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    return [path];
  const expected = reference as Record<string, unknown>,
    actual = candidate as Record<string, unknown>;
  return [
    ...Object.keys(actual)
      .filter((key) => !Object.hasOwn(expected, key))
      .map((key) => `${path}/${key}`),
    ...Object.keys(expected).flatMap((key) =>
      catalogIssues(actual[key], expected[key], `${path}/${key}`),
    ),
  ];
}
