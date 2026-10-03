import { classes } from "../../styles/classes";
import { useI18n } from "../../i18n/provider";
import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { api, type Profile } from "../../app/api";
import { useAuth } from "../../app/auth";
import { Notice } from "../../components/common";
import { LanguageSelect } from "../../i18n/LanguageSelect";
export function Login() {
  const { t } = useI18n();
  const a = useAuth(),
    navigate = useNavigate(),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [show, setShow] = useState(false),
    [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false);
  if (a.loading)
    return (
      <main className={classes("login")}>
        <p role="status">{t("app.loadingSession")}</p>
      </main>
    );
  if (a.user)
    return (
      <Navigate to={a.user.mustChangePassword ? "/account" : "/"} replace />
    );
  return (
    <main className={classes("login")}>
      <section className={classes("panel")}>
        <LanguageSelect />
        <p className={classes("eyebrow")}>{t("login.private")}</p>
        <h1>
          {t("login.video")}
          <br />
          {t("login.moment")}
        </h1>
        <p>{t("login.intro")}</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            void api<Profile>("/auth/login", "POST", { username, password })
              .then((u) => {
                a.accept(u);
                navigate(u.mustChangePassword ? "/account" : "/");
              })
              .catch(setError)
              .finally(() => setBusy(false));
          }}
        >
          <label>
            {t("login.username")}
            <input
              autoComplete="username"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label>
            {t("login.password")}
            <input
              type={show ? "text" : "password"}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label className={classes("check")}>
            <input
              type="checkbox"
              checked={show}
              onChange={(e) => setShow(e.target.checked)}
            />
            {t("login.showPassword")}
          </label>
          <Notice error={error} />
          <button className={classes("primary")} disabled={busy}>
            {busy ? t("login.entering") : t("login.enter")}
          </button>
        </form>
        <details>
          <summary>{t("login.recover")}</summary>
          <p>{t("login.recoveryHelp")}</p>
          <a href="/activate">{t("login.activationLink")}</a>
        </details>
      </section>
    </main>
  );
}
export function Activate() {
  const { t } = useI18n();
  const a = useAuth(),
    n = useNavigate(),
    [token, setToken] = useState(() => {
      const t = location.hash.slice(1);
      history.replaceState(null, "", location.pathname);
      return t;
    }),
    [password, setPassword] = useState(""),
    [error, setError] = useState<unknown>();
  return (
    <main className={classes("login")}>
      <section className={classes("panel")}>
        <LanguageSelect />
        <h1>{t("login.reset")}</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void api<Profile>("/auth/reset/consume", "POST", {
              token,
              password,
            })
              .then((u) => {
                a.accept(u);
                n("/");
              })
              .catch(setError);
          }}
        >
          <label>
            {t("login.token")}
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
              autoComplete="off"
            />
          </label>
          <label>
            {t("login.newPassword")}
            <input
              type="password"
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <Notice error={error} />
          <button className={classes("primary")}>{t("login.saveEnter")}</button>
        </form>
      </section>
    </main>
  );
}
