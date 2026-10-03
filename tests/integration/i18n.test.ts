import { beforeAll, afterAll, expect, it } from "vitest";
import { testApp, actor } from "../helpers/context.js";
let a: Awaited<ReturnType<typeof testApp>>,
  owner: Awaited<ReturnType<typeof actor>>,
  partner: Awaited<ReturnType<typeof actor>>;
let original: { id: string; preferences_json: Record<string, unknown> }[];
beforeAll(async () => {
  a = await testApp();
  owner = await actor(a);
  partner = await actor(a, "pareja");
  original = await a.db.query(
    "SELECT id,preferences_json FROM users ORDER BY slot",
  );
  await a.db.query(
    "UPDATE users SET preferences_json=preferences_json-'locale'",
  );
});
afterAll(async () => {
  for (const row of original)
    await a.db.query("UPDATE users SET preferences_json=$2 WHERE id=$1", [
      row.id,
      JSON.stringify(row.preferences_json),
    ]);
  await a.app.close();
});
it("I18N-04/05 existing accounts without saved locale default by role", async () => {
  for (const [who, locale] of [
    [owner, "es"],
    [partner, "pl"],
  ] as const) {
    const result = await a.app.inject({
      url: "/api/v1/auth/me",
      headers: who.headers,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().preferences.locale).toBe(locale);
  }
});
it("I18N-06/07/10 locale persists per account without changing sessions or other preferences", async () => {
  const before = await a.db.query(
    "SELECT id,revoked_at FROM sessions ORDER BY id",
  );
  const patch = await a.app.inject({
    method: "PATCH",
    url: "/api/v1/account",
    headers: owner.headers,
    payload: {
      preferences: { locale: "en", volume: 0.37, subtitleLanguage: "pl" },
    },
  });
  expect(patch.statusCode).toBe(200);
  expect(patch.json().preferences).toMatchObject({
    locale: "en",
    volume: 0.37,
    subtitleLanguage: "pl",
  });
  const newSession = await actor(a);
  expect(
    (
      await a.app.inject({
        url: "/api/v1/auth/me",
        headers: newSession.headers,
      })
    ).json().preferences.locale,
  ).toBe("en");
  expect(
    (
      await a.app.inject({ url: "/api/v1/auth/me", headers: partner.headers })
    ).json().preferences.locale,
  ).toBe("pl");
  const again = await a.app.inject({
    method: "PATCH",
    url: "/api/v1/account",
    headers: owner.headers,
    payload: { preferences: { locale: "pl" } },
  });
  expect(again.json().preferences).toMatchObject({
    locale: "pl",
    volume: 0.37,
    subtitleLanguage: "pl",
  });
  const after = await a.db.query<{ id: string; revoked_at: Date | null }>(
    "SELECT id,revoked_at FROM sessions ORDER BY id",
  );
  expect(
    after.filter((row) => before.some((old) => old.id === row.id)),
  ).toEqual(before);
});
it("invalid locale and CSRF reject changes without mutating either account", async () => {
  const before = await a.db.query(
    "SELECT id,preferences_json FROM users ORDER BY slot",
  );
  for (const [headers, locale] of [
    [owner.headers, "xx"],
    [{ ...partner.headers, "x-csrf-token": "wrong" }, "en"],
  ] as const) {
    const result = await a.app.inject({
      method: "PATCH",
      url: "/api/v1/account",
      headers,
      payload: { preferences: { locale } },
    });
    expect(result.statusCode).toBeGreaterThanOrEqual(400);
  }
  expect(
    await a.db.query("SELECT id,preferences_json FROM users ORDER BY slot"),
  ).toEqual(before);
});
