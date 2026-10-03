import { classes } from "../../styles/classes";
import { useI18n } from "../../i18n/provider";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Profile } from "../../app/api";
import { useAuth } from "../../app/auth";
import { Notice } from "../../components/common";
import { LanguagePreference } from "./LanguagePreference";
export function Account() {
  const { t } = useI18n();
  const auth = useAuth(),
    cache = useQueryClient(),
    [name, setName] = useState(auth.user?.displayName ?? ""),
    [password, setPassword] = useState(""),
    [current, setCurrent] = useState(""),
    [error, setError] = useState<unknown>(),
    [saved, setSaved] = useState<
      "account.profileSaved" | "account.passwordChanged" | null
    >(null);
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: () =>
      api<
        {
          id: string;
          device_label: string;
          current: boolean;
          last_seen_at: string;
        }[]
      >("/account/sessions"),
  });
  return (
    <>
      <h1>{t("nav.account")}</h1>
      {auth.user?.mustChangePassword && (
        <p role="alert">{t("account.initialPassword")}</p>
      )}
      <Notice error={error} />
      <p role="status">{saved && t(saved)}</p>
      <LanguagePreference />
      <div className={classes("accountGrid")}>
        <section className={classes("panel")}>
          <h2>{t("account.profile")}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void api<Profile>("/account", "PATCH", { displayName: name })
                .then((u) => {
                  auth.accept(u);
                  setSaved("account.profileSaved");
                })
                .catch(setError);
            }}
          >
            <label>
              {t("account.displayName")}
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                required
              />
            </label>
            <label>
              {t("account.avatar")}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  void file
                    .arrayBuffer()
                    .then((buffer) => {
                      if (buffer.byteLength > 2 * 1024 * 1024)
                        throw new ApiError("IMAGE_TOO_LARGE");
                      const bytes = new Uint8Array(buffer);
                      let binary = "";
                      for (const b of bytes) binary += String.fromCharCode(b);
                      return api<{ assetId: string }>(
                        "/account/avatar",
                        "POST",
                        { imageBase64: btoa(binary) },
                      );
                    })
                    .then((r) =>
                      api<Profile>("/account", "PATCH", {
                        avatarAssetId: r.assetId,
                      }),
                    )
                    .then(auth.accept)
                    .catch(setError);
                }}
              />
            </label>
            <button>{t("account.saveProfile")}</button>
          </form>
        </section>
        <section className={classes("panel")}>
          <h2>{t("login.password")}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void (
                current
                  ? api("/auth/reauth", "POST", { password: current })
                  : Promise.resolve()
              )
                .then(() =>
                  api<Profile>("/account/password", "POST", { password }),
                )
                .then((u) => {
                  auth.accept(u);
                  setPassword("");
                  setCurrent("");
                  setSaved("account.passwordChanged");
                })
                .catch(setError);
            }}
          >
            <label>
              {t("account.currentPassword")}
              <input
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </label>
            <label>
              {t("login.newPassword")}
              <input
                type="password"
                minLength={12}
                maxLength={128}
                required
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <button>{t("account.changePassword")}</button>
          </form>
        </section>
      </div>
      <section className={classes("panel")}>
        <h2>{t("account.sessions")}</h2>
        {sessions.data && (
          <p>{t("account.sessionCount", { count: sessions.data.length })}</p>
        )}
        <Notice error={sessions.error} />
        {sessions.data?.map((s) => (
          <div className={classes("session")} key={s.id}>
            <span>
              {s.device_label === "PASSWORD_RESET" ||
              s.device_label === "Recuperación"
                ? t("account.recovery")
                : s.device_label === "Navegador"
                  ? t("account.browser")
                  : s.device_label}
              {s.current && <> · {t("account.thisBrowser")}</>}
            </span>
            <button
              onClick={() =>
                void api(`/account/sessions/${s.id}`, "DELETE")
                  .then(() => {
                    void cache.invalidateQueries({ queryKey: ["sessions"] });
                    if (s.current) void auth.refresh();
                  })
                  .catch(setError)
              }
            >
              {t("account.revoke")}
            </button>
          </div>
        ))}
      </section>
    </>
  );
}
