import { classes } from "../../styles/classes";
import { ui } from "../../i18n/es";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Profile } from "../../app/api";
import { useAuth } from "../../app/auth";
import { Notice } from "../../components/common";
export function Account() {
  const auth = useAuth(),
    cache = useQueryClient(),
    [name, setName] = useState(auth.user?.displayName ?? ""),
    [password, setPassword] = useState(""),
    [current, setCurrent] = useState(""),
    [error, setError] = useState<unknown>(),
    [saved, setSaved] = useState("");
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
      <h1>{ui.mi_cuenta_1a5e17}</h1>
      {auth.user?.mustChangePassword && (
        <p role="alert">{ui.cambia_tu_contrasena_inicial_para_85e313}</p>
      )}
      <Notice error={error} />
      <p role="status">{saved}</p>
      <div className={classes("accountGrid")}>
        <section className={classes("panel")}>
          <h2>{ui.perfil_00d551}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void api<Profile>("/account", "PATCH", { displayName: name })
                .then((u) => {
                  auth.accept(u);
                  setSaved("Perfil guardado.");
                })
                .catch(setError);
            }}
          >
            <label>
              {ui.nombre_visible_45b7eb}
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                required
              />
            </label>
            <label>
              {ui.avatar_ca8e82}
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
                        throw new Error("La imagen supera 2 MiB.");
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
            <button>{ui.guardar_perfil_b54513}</button>
          </form>
        </section>
        <section className={classes("panel")}>
          <h2>{ui.contrasena_a389a6}</h2>
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
                  setSaved(
                    "Contraseña cambiada; las sesiones anteriores se han revocado.",
                  );
                })
                .catch(setError);
            }}
          >
            <label>
              {ui.contrasena_actual_14a433}
              <input
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </label>
            <label>
              {ui.nueva_contrasena_902e68}
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
            <button>{ui.cambiar_contrasena_050ccf}</button>
          </form>
        </section>
      </div>
      <section className={classes("panel")}>
        <h2>{ui.sesiones_propias_023023}</h2>
        <Notice error={sessions.error} />
        {sessions.data?.map((s) => (
          <div className={classes("session")} key={s.id}>
            <span>
              {s.device_label} {s.current ? "· Este navegador" : ""}
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
              {ui.revocar_2634b5}
            </button>
          </div>
        ))}
      </section>
    </>
  );
}
