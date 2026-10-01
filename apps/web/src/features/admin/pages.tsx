import { classes } from "../../styles/classes";
import { ui } from "../../i18n/es";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  csrfToken,
  ApiError,
  type Media,
  type Profile,
} from "../../app/api";
import { Notice, Confirm } from "../../components/common";
export function AdminNav() {
  return (
    <nav className={classes("subnav")} aria-label={ui.administracion_1a1b3e}>
      <Link to="/admin/videos">{ui.contenido_197c7a}</Link>
      <Link to="/admin/accounts">{ui.cuentas_7c1ca4}</Link>
      <Link to="/admin/storage">{ui.almacenamiento_43e23b}</Link>
      <Link to="/admin/integrations">{ui.google_drive_915ef4}</Link>
      <Link to="/admin/system">{ui.sistema_f150af}</Link>
    </nav>
  );
}
export function Reauth() {
  const [password, setPassword] = useState(""),
    [error, setError] = useState<unknown>(),
    [ok, setOk] = useState(false);
  return (
    <details>
      <summary>{ui.confirmar_acceso_para_acciones_sensibles_a92ee8}</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void api("/auth/reauth", "POST", { password })
            .then(() => {
              setOk(true);
              setPassword("");
            })
            .catch(setError);
        }}
      >
        <label>
          {ui.tu_contrasena_e21e08}
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <button>{ui.confirmar_acceso_d911b8}</button>
        <Notice error={error} />
        {ok && (
          <p role="status">{ui.acceso_confirmado_durante_10_minutos_ca320c}</p>
        )}
      </form>
    </details>
  );
}
interface Upload {
  id: string;
  mediaId: string;
  offset: number;
  expectedBytes: number;
  name?: string;
}
export function AddVideo() {
  const navigate = useNavigate(),
    [title, setTitle] = useState(""),
    [description, setDescription] = useState(""),
    [category, setCategory] = useState(""),
    [url, setUrl] = useState(""),
    [file, setFile] = useState<File | null>(null),
    [error, setError] = useState<unknown>(),
    [inspection, setInspection] = useState<{
      kind: string;
      durationSeconds: number;
      delivery: string;
    } | null>(null),
    [progress, setProgress] = useState(0),
    [busy, setBusy] = useState(false),
    [upload, setUpload] = useState<Upload | null>(() => {
      try {
        return JSON.parse(localStorage.getItem("rave-upload") ?? "null");
      } catch {
        return null;
      }
    });
  const uploadFile = async () => {
    if (!file) throw new Error("Selecciona de nuevo el archivo original.");
    let u = upload;
    if (u && u.expectedBytes !== file.size)
      throw new Error(
        "El archivo seleccionado tiene otro tamaño. Cancela la subida o selecciona el original.",
      );
    if (!u) {
      u = await api<Upload>("/admin/uploads", "POST", {
        title,
        description,
        category: category || null,
        originalName: file.name,
        expectedBytes: file.size,
      });
      u.name = file.name;
      setUpload(u);
      localStorage.setItem("rave-upload", JSON.stringify(u));
    }
    const head = await fetch(`/api/v1/admin/uploads/${u.id}`, {
      method: "HEAD",
    });
    if (!head.ok) throw new Error("Esta subida ya no está disponible.");
    let offset = Number(head.headers.get("Upload-Offset"));
    while (offset < file.size) {
      const chunk = file.slice(
        offset,
        Math.min(file.size, offset + 8 * 1024 * 1024),
      );
      const response = await fetch(`/api/v1/admin/uploads/${u.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-CSRF-Token": csrfToken(),
          "Upload-Offset": String(offset),
        },
        body: chunk,
      });
      if (!response.ok) {
        const e = await response.json();
        throw new ApiError(e.code);
      }
      offset = Number(response.headers.get("Upload-Offset"));
      setProgress(offset / file.size);
    }
    await api(`/admin/uploads/${u.id}/complete`, "POST");
    localStorage.removeItem("rave-upload");
    navigate(`/admin/videos/${u.mediaId}`);
  };
  return (
    <>
      <AdminNav />
      <h1>{ui.anadir_video_d471c2}</h1>
      <p>{ui.el_contenido_se_guarda_como_9e02fe}</p>
      <Notice error={error} />
      <form
        className={classes("panel")}
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void (
            file || upload
              ? uploadFile()
              : api<{ id: string }>("/admin/videos", "POST", {
                  title,
                  description,
                  category: category || null,
                }).then(async (m) => {
                  await api(`/admin/videos/${m.id}/sources`, "POST", {
                    url,
                    sameContent: false,
                  });
                  navigate(`/admin/videos/${m.id}`);
                })
          )
            .catch(setError)
            .finally(() => setBusy(false));
        }}
      >
        <label>
          {ui.titulo_4c08a5}
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={200}
          />
        </label>
        <label>
          {ui.descripcion_ee00b9}
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={4000}
          />
        </label>
        <label>
          {ui.categoria_558bb2}
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            maxLength={80}
          />
        </label>
        <label>
          {ui.archivo_propio_92d3f7}
          <input
            type="file"
            accept="video/*,.mkv"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, ""));
            }}
          />
        </label>
        {upload && (
          <p>
            {ui.subida_pendiente_a74dd5}
            {upload.name}
            {ui.selecciona_el_mismo_archivo_para_d0d962}
          </p>
        )}
        <label>
          {ui.o_enlace_https_compatible_b5ce40}
          <input
            type="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setInspection(null);
            }}
            placeholder={ui.https_ab04e2}
            disabled={!!file || !!upload}
          />
        </label>
        {url && !file && !upload && (
          <button
            type="button"
            onClick={() =>
              void api<typeof inspection>("/admin/sources/inspect", "POST", {
                url,
              })
                .then(setInspection)
                .catch(setError)
            }
          >
            {ui.verificar_enlace_c8f4a2}
          </button>
        )}
        {inspection && (
          <p>
            {inspection.kind}
            {ui._588da4}
            {inspection.durationSeconds.toFixed(1)}
            {ui.s_61716b} {inspection.delivery}
          </p>
        )}
        <progress aria-label={ui.subida_5100ee} max={1} value={progress} />
        <div className={classes("actions")}>
          <button
            disabled={busy || (!file && !upload && !inspection)}
            className={classes("primary")}
          >
            {busy
              ? `Subiendo ${Math.round(progress * 100)}%…`
              : upload
                ? "Reanudar subida"
                : "Crear borrador"}
          </button>
          {upload && (
            <Confirm
              label={ui.cancelar_subida_535fc6}
              title={ui.cancelar_esta_subida_54caef}
              onConfirm={async () => {
                await api(`/admin/uploads/${upload.id}`, "DELETE");
                setUpload(null);
                localStorage.removeItem("rave-upload");
              }}
            />
          )}
        </div>
        <Link to="/admin/integrations">
          {ui.anadir_desde_google_drive_4d6a2f}
        </Link>
      </form>
    </>
  );
}
interface EditableMedia extends Media {
  primarySourceId?: string;
}
export function EditVideo() {
  const { id } = useParams(),
    cache = useQueryClient(),
    navigate = useNavigate(),
    [error, setError] = useState<unknown>(),
    [title, setTitle] = useState(""),
    [description, setDescription] = useState(""),
    [category, setCategory] = useState(""),
    [url, setUrl] = useState(""),
    [same, setSame] = useState(false),
    [subfile, setSubfile] = useState<File | null>(null),
    [subLabel, setSubLabel] = useState("Español"),
    [subLang, setSubLang] = useState("es"),
    [chapters, setChapters] = useState("");
  const q = useQuery({
    queryKey: ["admin-media", id],
    queryFn: () => api<EditableMedia>(`/media/${id}`),
    refetchInterval: 3000,
  });
  const m = q.data;
  useEffect(() => {
    if (m) {
      setTitle(m.title);
      setDescription(m.description);
      setCategory(m.category ?? "");
      setChapters(
        (m.chapters ?? [])
          .map((c) => `${c.startSeconds} | ${c.title}`)
          .join("\n"),
      );
    }
  }, [m?.id]);
  const refresh = () =>
    cache.invalidateQueries({ queryKey: ["admin-media", id] });
  const action = (path: string, method = "POST", body: unknown = {}) =>
    api(`/admin/${path}`, method, body).then(refresh).catch(setError);
  return (
    <>
      <AdminNav />
      <h1>{m?.title ?? "Editar vídeo"}</h1>
      <Notice error={q.error ?? error} />
      <Reauth />
      {m && (
        <>
          <p>
            {m.publicationState}
            {ui._588da4}
            {m.health}
            {ui._588da4}
            {m.durationSeconds.toFixed(1)} {ui.segundos_324ea9}
          </p>
          <form
            className={classes("panel")}
            onSubmit={(e) => {
              e.preventDefault();
              void action(`videos/${id}`, "PATCH", {
                title,
                description,
                category: category || null,
              });
            }}
          >
            <label>
              {ui.titulo_4c08a5}
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </label>
            <label>
              {ui.descripcion_ee00b9}
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label>
              {ui.categoria_558bb2}
              <input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              />
            </label>
            <button>{ui.guardar_metadatos_6f49ed}</button>
            <label>
              {ui.reemplazar_portada_459836}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const reader = new FileReader();
                  reader.onload = () =>
                    void api<{ assetId: string }>(
                      `/admin/videos/${id}/poster`,
                      "POST",
                      { imageBase64: String(reader.result).split(",")[1] },
                    )
                      .then((r) =>
                        action(`videos/${id}`, "PATCH", {
                          posterAssetId: r.assetId,
                        }),
                      )
                      .catch(setError);
                  reader.readAsDataURL(f);
                }}
              />
            </label>
          </form>
          <div className={classes("actions")}>
            <button
              disabled={m.health !== "READY"}
              onClick={() => void action(`videos/${id}/publish`)}
            >
              {ui.publicar_326fdf}
            </button>
            <button onClick={() => void action(`videos/${id}/withdraw`)}>
              {ui.retirar_0eeac7}
            </button>
            {m.sourceKind === "local" && (
              <button onClick={() => void action(`videos/${id}/hls`)}>
                {ui.preparar_varias_calidades_hls_d9d729}
              </button>
            )}
            <Confirm
              label={ui.eliminar_video_3c2b87}
              title={ui.eliminar_este_video_793cb1}
              onConfirm={async () => {
                await api(`/admin/videos/${id}`, "DELETE");
                navigate("/admin/videos");
              }}
            >
              {ui.se_eliminan_los_archivos_propios_cab902}
            </Confirm>
          </div>
          {m.primarySourceId && m.sourceKind === "drive" && (
            <button
              onClick={() =>
                void action(`sources/${m.primarySourceId}/recheck`)
              }
            >
              {ui.volver_a_verificar_61af3e}
            </button>
          )}
          {m.primarySourceId &&
            m.sourceKind !== "local" &&
            m.sourceKind !== "drive" && (
              <section className={classes("panel")}>
                <h2>{ui.fuente_382897}</h2>
                <label>
                  {ui.nuevo_enlace_076fce}
                  <input
                    type="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                </label>
                <label className={classes("check")}>
                  <input
                    type="checkbox"
                    checked={same}
                    onChange={(e) => setSame(e.target.checked)}
                  />
                  {ui.es_el_mismo_contenido_ad4e55}
                </label>
                <button
                  onClick={() =>
                    void action(`sources/${m.primarySourceId}`, "PATCH", {
                      url,
                      sameContent: same,
                    })
                  }
                >
                  {ui.reemplazar_y_verificar_0eadfd}
                </button>
                <button
                  onClick={() =>
                    void action(`sources/${m.primarySourceId}/recheck`)
                  }
                >
                  {ui.volver_a_verificar_61af3e}
                </button>
                <Confirm
                  label={ui.preparar_copia_compatible_7e59e7}
                  title={ui.copiar_este_contenido_al_servidor_f05948}
                  onConfirm={() =>
                    action(
                      `sources/${m.primarySourceId}/prepare-copy`,
                      "POST",
                      { authorized: true },
                    )
                  }
                >
                  {ui.confirma_que_tienes_autorizacion_se_aef12c}
                </Confirm>
              </section>
            )}
          <section className={classes("panel")}>
            <h2>{ui.subtitulos_ef43f8}</h2>
            <label>
              {ui.archivo_srt_vtt_798ce9}
              <input
                type="file"
                accept=".srt,.vtt"
                onChange={(e) => setSubfile(e.target.files?.[0] ?? null)}
              />
            </label>
            <label>
              {ui.nombre_562bb1}
              <input
                value={subLabel}
                onChange={(e) => setSubLabel(e.target.value)}
              />
            </label>
            <label>
              {ui.idioma_7ae9d4}
              <input
                value={subLang}
                onChange={(e) => setSubLang(e.target.value)}
              />
            </label>
            <button
              disabled={!subfile}
              onClick={() =>
                void subfile
                  ?.text()
                  .then((text) =>
                    action(`videos/${id}/subtitles`, "POST", {
                      text,
                      label: subLabel,
                      language: subLang,
                    }),
                  )
                  .catch(setError)
              }
            >
              {ui.anadir_subtitulos_ef0fb8}
            </button>
          </section>
          <section className={classes("panel")}>
            <h2>{ui.capitulos_f8b001}</h2>
            <label>
              {ui.un_capitulo_por_linea_segundos_76d399}
              <textarea
                rows={5}
                value={chapters}
                onChange={(e) => setChapters(e.target.value)}
              />
            </label>
            <button
              onClick={() =>
                void action(`videos/${id}/chapters`, "PUT", {
                  chapters: chapters.trim()
                    ? chapters.split("\n").map((line) => {
                        const [n, ...title] = line.split("|");
                        return {
                          startSeconds: Number(n.trim()),
                          title: title.join("|").trim(),
                        };
                      })
                    : [],
                })
              }
            >
              {ui.guardar_capitulos_4fb752}
            </button>
          </section>
        </>
      )}
    </>
  );
}
export function Accounts() {
  const q = useQuery({
      queryKey: ["accounts"],
      queryFn: () =>
        api<(Profile & { disabled: boolean })[]>("/admin/accounts"),
    }),
    cache = useQueryClient(),
    [error, setError] = useState<unknown>(),
    [reset, setReset] = useState("");
  const action = async (
    id: string,
    path: string,
    method = "POST",
    body: unknown = {},
  ) => {
    await api(`/admin/accounts/${id}${path}`, method, body);
    await cache.invalidateQueries({ queryKey: ["accounts"] });
  };
  return (
    <>
      <AdminNav />
      <h1>{ui.las_dos_cuentas_32e4c8}</h1>
      <Reauth />
      <Notice error={q.error ?? error} />
      {q.data?.map((u) => (
        <section className={classes("panel")} key={u.id}>
          <h2>{u.displayName}</h2>
          <p>
            {u.username}
            {ui._588da4}
            {u.role}
            {ui._588da4}
            {u.disabled ? "Desactivada" : "Activa"}
          </p>
          <label>
            {ui.nombre_visible_45b7eb}
            <input
              defaultValue={u.displayName}
              onBlur={(e) => {
                if (e.target.value !== u.displayName)
                  void action(u.id, "", "PATCH", {
                    displayName: e.target.value,
                  }).catch(setError);
              }}
            />
          </label>
          <div className={classes("actions")}>
            {u.role === "PARTNER" && (
              <Confirm
                label={u.disabled ? "Reactivar" : "Desactivar"}
                title={ui.cambiar_el_acceso_de_la_23801d}
                onConfirm={() =>
                  action(u.id, "", "PATCH", { disabled: !u.disabled })
                }
              >
                {ui.desactivar_revoca_sesiones_reproductores_y_5cda1b}
              </Confirm>
            )}
            <button
              onClick={() =>
                void api<{ activationUrl: string }>(
                  `/admin/accounts/${u.id}/reset`,
                  "POST",
                )
                  .then((r) => setReset(r.activationUrl))
                  .catch(setError)
              }
            >
              {ui.emitir_restablecimiento_4c63a3}
            </button>
            <Confirm
              label={ui.revocar_sesiones_2e9e69}
              title={ui.revocar_todas_las_sesiones_eefeef}
              onConfirm={() => action(u.id, "/revoke-sessions")}
            />
          </div>
        </section>
      ))}
      {reset && (
        <section className={classes("panel")}>
          <p>{ui.enlace_privado_de_un_solo_72a4df}</p>
          <input
            aria-label={ui.enlace_de_restablecimiento_527b32}
            value={reset}
            readOnly
          />
          <button onClick={() => setReset("")}>
            {ui.ocultar_enlace_938ff4}
          </button>
        </section>
      )}
    </>
  );
}
interface Job {
  id: string;
  kind: string;
  state: string;
  progress: number;
  safe_error_code: string | null;
}
interface System {
  storage: { freeBytes: string; totalBytes: string; assetBytes: string };
  settings: { key: string; value_json: unknown }[];
  mode: string;
  backupLocation: string;
}
export function SystemPage({ storage = false }: { storage?: boolean }) {
  const q = useQuery({
      queryKey: ["system"],
      queryFn: () => api<System>("/admin/system"),
      refetchInterval: 5000,
    }),
    jobs = useQuery({
      queryKey: ["jobs"],
      queryFn: () => api<Job[]>("/admin/jobs"),
      refetchInterval: 2000,
    }),
    [error, setError] = useState<unknown>(),
    [retention, setRetention] = useState(30);
  return (
    <>
      <AdminNav />
      <h1>{storage ? "Almacenamiento y trabajos" : "Sistema"}</h1>
      <Notice error={q.error ?? jobs.error ?? error} />
      <Reauth />
      {q.data && (
        <section className={classes("panel")}>
          <h2>{ui.espacio_real_fc06eb}</h2>
          <p>
            {ui.libre_94a109}
            {(Number(q.data.storage.freeBytes) / 1024 ** 3).toFixed(2)}{" "}
            {ui.gib_archivos_456112}{" "}
            {(Number(q.data.storage.assetBytes) / 1024 ** 3).toFixed(2)}
            {ui.gib_dfecd1}
          </p>
          <p>
            {ui.entorno_f278c0}
            {q.data.mode}
            {ui.copias_b63714}
            {q.data.backupLocation}
            {ui.una_copia_en_el_mismo_bc79b5}
          </p>
        </section>
      )}
      {!storage && (
        <section className={classes("panel")}>
          <h2>{ui.retencion_del_chat_733e82}</h2>
          <label>
            {ui.dias_7fdaf8}
            <input
              type="number"
              min={1}
              max={365}
              value={retention}
              onChange={(e) => setRetention(Number(e.target.value))}
            />
          </label>
          <button
            onClick={() =>
              void api("/admin/settings", "PATCH", {
                chatRetentionDays: retention,
              }).catch(setError)
            }
          >
            {ui.guardar_13e51a}
          </button>
          <Confirm
            label={ui.limpiar_chat_b64ce1}
            title={ui.borrar_el_historial_del_chat_d4aae5}
            onConfirm={() => api("/admin/room/chat", "DELETE")}
          >
            {ui.no_elimina_copias_de_seguridad_143056}
          </Confirm>
          <h2>{ui.operacion_1bf216}</h2>
          <p>{ui.los_comandos_de_backup_restauracion_a98900}</p>
        </section>
      )}
      <h2>{ui.trabajos_555551}</h2>
      {jobs.data?.map((j) => (
        <section className={classes("panel")} key={j.id}>
          <h3>{j.kind}</h3>
          <p>
            {j.state} {j.safe_error_code ?? ""}
          </p>
          <progress
            aria-label={ui.procesamiento_5e598c}
            max={1}
            value={j.progress}
          />
          <div className={classes("actions")}>
            {j.state === "failed" && (
              <button
                onClick={() =>
                  void api(`/admin/jobs/${j.id}/retry`, "POST").catch(setError)
                }
              >
                {ui.reintentar_a9254c}
              </button>
            )}
            {["queued", "running"].includes(j.state) && (
              <button
                onClick={() =>
                  void api(`/admin/jobs/${j.id}/cancel`, "POST").catch(setError)
                }
              >
                {ui.cancelar_bb9dbb}
              </button>
            )}
          </div>
        </section>
      ))}
    </>
  );
}
interface DriveState {
  implemented: boolean;
  configured: boolean;
  authorized: boolean;
  liveVerifiedAt: string | null;
}
interface PickerConfig {
  accessToken: string;
  apiKey: string;
  appId: string;
  origin: string;
}
interface PickerLibrary {
  PickerBuilder: new () => {
    addView: (v: unknown) => unknown;
    setOAuthToken: (t: string) => unknown;
    setDeveloperKey: (k: string) => unknown;
    setAppId: (id: string) => unknown;
    setOrigin: (o: string) => unknown;
    setCallback: (
      cb: (d: { action: string; docs?: { id: string }[] }) => void,
    ) => unknown;
    build: () => { setVisible: (v: boolean) => void };
  };
  DocsView: new () => { setMimeTypes: (v: string) => unknown };
}
export function DrivePage() {
  const q = useQuery({
      queryKey: ["drive"],
      queryFn: () => api<DriveState>("/admin/drive/status"),
    }),
    [error, setError] = useState<unknown>();
  const picker = async () => {
    const config = await api<PickerConfig>("/admin/drive/picker-token", "POST");
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://apis.google.com/js/api.js";
      script.onload = () => resolve();
      script.onerror = () =>
        reject(new Error("No se pudo cargar Google Picker."));
      document.head.append(script);
    });
    const w = window as unknown as {
      gapi: { load: (name: string, cb: () => void) => void };
      google: { picker: PickerLibrary };
    };
    await new Promise<void>((resolve) => w.gapi.load("picker", resolve));
    const p = w.google.picker,
      view = new p.DocsView();
    view.setMimeTypes("video/mp4,video/webm,video/quicktime");
    const builder = new p.PickerBuilder();
    builder.addView(view);
    builder.setOAuthToken(config.accessToken);
    builder.setDeveloperKey(config.apiKey);
    builder.setAppId(config.appId);
    builder.setOrigin(config.origin);
    builder.setCallback((d) => {
      if (d.action === "picked" && d.docs)
        void api("/admin/drive/import", "POST", {
          fileIds: d.docs.map((v) => v.id),
        })
          .then(() => {
            location.assign("/admin/videos");
          })
          .catch(setError);
    });
    builder.build().setVisible(true);
  };
  return (
    <>
      <AdminNav />
      <h1>{ui.google_drive_915ef4}</h1>
      <Reauth />
      <Notice error={q.error ?? error} />
      <section className={classes("panel")}>
        <h2>
          {!q.data?.configured
            ? "Necesita configuración"
            : q.data.authorized
              ? "Autorizado"
              : "Necesita autorización"}
        </h2>
        <p>{ui.solo_jason_selecciona_archivos_concretos_7938d3}</p>
        <p>
          {ui.prueba_real_b4d237}
          {q.data?.liveVerifiedAt ?? "No verificada"}
        </p>
        {!q.data?.configured ? (
          <p>{ui.configura_google_client_id_google_2a57a0}</p>
        ) : (
          <div className={classes("actions")}>
            <button
              onClick={() =>
                void api<{ authorizationUrl: string }>(
                  "/admin/drive/connect",
                  "POST",
                )
                  .then((r) => location.assign(r.authorizationUrl))
                  .catch(setError)
              }
            >
              {q.data.authorized ? "Reconectar" : "Conectar"}
            </button>
            {q.data.authorized && (
              <>
                <button onClick={() => void picker().catch(setError)}>
                  {ui.elegir_videos_de_drive_1e82d0}
                </button>
                <Confirm
                  label={ui.desconectar_drive_a473c9}
                  title={ui.desconectar_google_drive_818a63}
                  onConfirm={() =>
                    api("/admin/drive/connection", "DELETE").then(() =>
                      q.refetch(),
                    )
                  }
                >
                  {ui.se_revoca_el_acceso_y_f1a117}
                </Confirm>
              </>
            )}
          </div>
        )}
        <p>{ui.en_modo_oauth_testing_algunos_c0cb14}</p>
      </section>
    </>
  );
}
