import { classes } from "../../styles/classes";
import { ui } from "../../i18n/es";
import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { api, type Profile } from "../../app/api";
import { useAuth } from "../../app/auth";
import { Notice } from "../../components/common";
export function Login() {
  const a = useAuth(),
    navigate = useNavigate(),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [show, setShow] = useState(false),
    [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false);
  if (a.user)
    return (
      <Navigate to={a.user.mustChangePassword ? "/account" : "/"} replace />
    );
  return (
    <main className={classes("login")}>
      <section className={classes("panel")}>
        <p className={classes("eyebrow")}>{ui.solo_vosotros_dos_5bc50f}</p>
        <h1>
          {ui.un_video_e117c4}
          <br />
          {ui.vuestro_momento_20028f}
        </h1>
        <p>{ui.entra_en_rave_privado_para_c46fbf}</p>
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
            {ui.usuario_63614f}
            <input
              autoComplete="username"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label>
            {ui.contrasena_a389a6}
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
            {ui.mostrar_contrasena_5fe3b7}
          </label>
          <Notice error={error} />
          <button className={classes("primary")} disabled={busy}>
            {busy ? "Entrando…" : "Entrar"}
          </button>
        </form>
        <details>
          <summary>{ui.recuperar_acceso_8f849b}</summary>
          <p>{ui.jason_puede_emitir_un_enlace_13ccd3}</p>
          <a href="/activate">{ui.tengo_un_enlace_de_activacion_a69b18}</a>
        </details>
      </section>
    </main>
  );
}
export function Activate() {
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
        <h1>{ui.restablecer_acceso_05f968}</h1>
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
            {ui.token_d2089b}
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
              autoComplete="off"
            />
          </label>
          <label>
            {ui.nueva_contrasena_902e68}
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
          <button className={classes("primary")}>
            {ui.guardar_y_entrar_8f3c45}
          </button>
        </form>
      </section>
    </main>
  );
}
