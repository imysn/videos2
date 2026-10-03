import { describe, expect, it } from "vitest";
import { Linter, ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { noUiLiterals } from "../../scripts/eslint-i18n.mjs";
import {
  catalogs,
  catalogIssues,
  createTranslator,
  errorText,
  accountLocale,
  SUPPORTED_LOCALES,
  intlLocales,
} from "../../apps/web/src/i18n/index";
import { preLoginLocale } from "../../apps/web/src/i18n/provider";
import { preferencesSchema } from "../../packages/contracts/src/index";
import type { Catalog } from "../../apps/web/src/i18n/types";

describe("Permanent i18n contract", () => {
  it("I18N-01 supports ES, PL and EN equally", () => {
    expect(SUPPORTED_LOCALES).toEqual(["es", "pl", "en"]);
    expect(Object.keys(catalogs).sort()).toEqual([...SUPPORTED_LOCALES].sort());
    expect(intlLocales).toEqual({ es: "es-ES", pl: "pl-PL", en: "en-GB" });
  });
  it.each(SUPPORTED_LOCALES)(
    "I18N-02/03 exact structure, nonempty values and interpolation parity: %s",
    (locale) => {
      expect(catalogIssues(catalogs[locale])).toEqual([]);
    },
  );
  it("I18N-04/05 defaults use stable roles, invalid stored preferences are safe", () => {
    expect(accountLocale("OWNER", undefined)).toBe("es");
    expect(accountLocale("PARTNER", undefined)).toBe("pl");
    expect(accountLocale("PARTNER", "xx")).toBe("pl");
    expect(accountLocale("OWNER", "en")).toBe("en");
    expect(preferencesSchema.safeParse({ locale: "xx" }).success).toBe(false);
  });
  it("I18N-08 browser choice precedes navigator and safe fallback", () => {
    expect(preLoginLocale("pl", ["es-ES", "en"])).toBe("pl");
    expect(preLoginLocale(null, ["fr", "en-US"])).toBe("en");
    expect(preLoginLocale("invalid", ["pl-PL"])).toBe("pl");
    expect(preLoginLocale(null, ["de-DE"])).toBe("es");
  });
  it("I18N-15 known HTTP/socket/client errors localise and hide arbitrary upstream messages", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const t = createTranslator(locale);
      expect(errorText(t, { code: "AUTH_REQUIRED" })).toBe(
        t("error.AUTH_REQUIRED"),
      );
      expect(errorText(t, new Error("NOT_HOST"))).toBe(t("error.NOT_HOST"));
      expect(errorText(t, { code: "STALE_HOST_EPOCH" })).toBe(
        t("error.STALE_REVISION"),
      );
      expect(
        errorText(t, new Error("https://private.example/secret-token")),
      ).toBe(t("error.generic"));
    }
    expect(
      new Set(
        SUPPORTED_LOCALES.map((locale) =>
          errorText(createTranslator(locale), { code: "INVALID_CREDENTIALS" }),
        ),
      ).size,
    ).toBe(3);
  });
  it("Polish plural rules cover 1, 2, 5, 12, 22, 101 and fractional counts", () => {
    const t = createTranslator("pl");
    expect(t("account.sessionCount", { count: 1 })).toBe("1 aktywna sesja");
    expect(t("account.sessionCount", { count: 2 })).toBe("2 aktywne sesje");
    expect(t("account.sessionCount", { count: 5 })).toBe("5 aktywnych sesji");
    expect(t("account.sessionCount", { count: 12 })).toBe("12 aktywnych sesji");
    expect(t("account.sessionCount", { count: 22 })).toBe("22 aktywne sesje");
    expect(t("account.sessionCount", { count: 101 })).toBe(
      "101 aktywnych sesji",
    );
    expect(t("account.sessionCount", { count: 1.5 })).toBe(
      "1,5 aktywnej sesji",
    );
  });
  it("semantic interpolation allows languages to reorder values", () => {
    expect(createTranslator("en")("room.hostControl", { name: "Jason" })).toBe(
      "Jason is in control",
    );
    expect(createTranslator("pl")("room.hostControl", { name: "Jason" })).toBe(
      "Steruje: Jason",
    );
  });
  it("I18N-19 runtime fallback is resilient; release validator rejects omissions, additions, blanks and divergent structure", () => {
    const broken = { ...catalogs.pl, "player.fullscreen": "" };
    const missing: string[] = [];
    expect(
      createTranslator("pl", broken, (key) => missing.push(key))(
        "player.fullscreen",
      ),
    ).toBe("Pantalla completa");
    expect(missing).toEqual(["player.fullscreen"]);
    expect(catalogIssues(broken)).toContain("/player.fullscreen");
    const omitted = { ...catalogs.en } as Record<string, unknown>;
    delete omitted["player.fullscreen"];
    expect(catalogIssues(omitted)).toContain("/player.fullscreen");
    expect(catalogIssues({ ...catalogs.en, extra: "Unexpected" })).toContain(
      "/extra",
    );
    expect(
      catalogIssues({ ...catalogs.en, "account.sessionCount": "wrong shape" }),
    ).toContain("/account.sessionCount");
    expect(
      catalogIssues({
        ...catalogs.en,
        "watch.startPersonal": "Missing parameter",
      }),
    ).toContain("/watch.startPersonal");
  });
});

function lint(source: string) {
  return new Linter().verify(
    source,
    [
      {
        files: ["**/*.tsx"],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        plugins: { i18n: { rules: { "no-ui-literals": noUiLiterals } } },
        rules: { "i18n/no-ui-literals": "error" },
      },
    ],
    { filename: "example.tsx" },
  );
}
describe("I18N-16 AST hardcoded text gate", () => {
  it("the repository's actual lint configuration enforces the rule for future components", async () => {
    const [result] = await new ESLint().lintText(
      "export function Future() { return <button>Guardar</button>; }",
      { filePath: "apps/web/src/future-regression.tsx" },
    );
    expect(
      result.messages.some(
        (message) => message.ruleId === "i18n/no-ui-literals",
      ),
    ).toBe(true);
  });
  it.each([
    "const view = <button>Guardar</button>;",
    'const view = <button>{"save"}</button>;',
    'setSaved("Perfil guardado.");',
    'setSaved("Saved");',
    'setSaved("saved");',
    'const view = <input aria-label="Volumen" placeholder="Your name" />;',
    'const view = <button onClick={() => setSaved("Perfil guardado.")}>{t("common.save")}</button>;',
    "const view = <p>{`Libre: ${value} GiB`}</p>;",
    'const view = <p>{"Libre: " + value}</p>;',
  ])("rejects human text: %s", (source) =>
    expect(lint(source).length).toBeGreaterThan(0),
  );
  it.each([
    'const view = <button>{t("common.save")}</button>;',
    'const view = <input aria-label={t("player.volume")} data-testid="volume" type="range" />;',
    "const view = <p>{userMessage}</p>;",
    'const view = <span aria-hidden="true">▶ +10</span>;',
    'const view = <video src="/media/123" crossOrigin="anonymous" />;',
    'const headers = {"Content-Type":"video/mp4"}; const code = "AUTH_REQUIRED";',
    'const view = <button onClick={() => api(`/admin/videos/${id}`, "POST")}>{t("admin.publish")}</button>;',
  ])("allows content data and technical values: %s", (source) =>
    expect(lint(source)).toEqual([]),
  );
});

// These compile-time regressions also run in the normal strict TypeScript/CI gate.
function typeContract() {
  const t = createTranslator("en");
  // @ts-expect-error unknown keys must fail compilation
  t("future.esOnlyFeature");
  // @ts-expect-error required semantic interpolation
  t("watch.startPersonal");
  // @ts-expect-error wrong interpolation field
  t("watch.startPersonal", { position: "01:23" });
  // @ts-expect-error no unexpected catalog entries
  const extra: Catalog = { ...catalogs.en, extra: "Unexpected" };
  // @ts-expect-error complete catalogs are required
  const absent: Catalog = {};
  void extra;
  void absent;
}
void typeContract;
