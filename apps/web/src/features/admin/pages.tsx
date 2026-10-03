import { classes } from "../../styles/classes";
import { errorText, localeNames } from "../../i18n/index";
import { useI18n } from "../../i18n/provider";
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
  const { t } = useI18n();
  return (
    <nav className={classes("subnav")} aria-label={t("nav.admin")}>
      <Link to="/admin/videos">{t("admin.content")}</Link>
      <Link to="/admin/accounts">{t("admin.accounts")}</Link>
      <Link to="/admin/storage">{t("admin.storage")}</Link>
      <Link to="/admin/integrations">{t("admin.drive")}</Link>
      <Link to="/admin/system">{t("admin.system")}</Link>
    </nav>
  );
}
export function Reauth() {
  const { t } = useI18n();
  const [password, setPassword] = useState(""),
    [error, setError] = useState<unknown>(),
    [ok, setOk] = useState(false);
  return (
    <details>
      <summary>{t("admin.reauthPrompt")}</summary>
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
          {t("admin.yourPassword")}
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <button>{t("admin.reauth")}</button>
        <Notice error={error} />
        {ok && <p role="status">{t("admin.reauthSuccess")}</p>}
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
  const { t, label, number } = useI18n();
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
    if (!file) throw new ApiError("UPLOAD_FILE_REQUIRED");
    let u = upload;
    if (u && u.expectedBytes !== file.size)
      throw new ApiError("UPLOAD_SIZE_MISMATCH");
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
    if (!head.ok) throw new ApiError("UPLOAD_UNAVAILABLE");
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
      <h1>{t("admin.addVideo")}</h1>
      <p>{t("admin.draftHelp")}</p>
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
          {t("media.title")}
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={200}
          />
        </label>
        <label>
          {t("media.description")}
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={4000}
          />
        </label>
        <label>
          {t("media.category")}
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            maxLength={80}
          />
        </label>
        <label>
          {t("source.local")}
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
        {upload && <p>{t("admin.resumeHelp", { name: upload.name ?? "—" })}</p>}
        <label>
          {t("admin.httpsLink")}
          <input
            type="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setInspection(null);
            }}
            placeholder={"https://…"}
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
            {t("admin.verifyLink")}
          </button>
        )}
        {inspection && (
          <p>
            {t("admin.inspection", {
              kind: label("source", inspection.kind),
              seconds: number(inspection.durationSeconds, {
                maximumFractionDigits: 1,
              }),
              delivery: label("source", inspection.delivery),
            })}
          </p>
        )}
        <progress aria-label={t("admin.upload")} max={1} value={progress} />
        <div className={classes("actions")}>
          <button
            disabled={busy || (!file && !upload && !inspection)}
            className={classes("primary")}
          >
            {busy
              ? t("admin.uploading", {
                  percent: number(progress, {
                    style: "percent",
                    maximumFractionDigits: 0,
                  }),
                })
              : upload
                ? t("admin.resumeUpload")
                : t("admin.createDraft")}
          </button>
          {upload && (
            <Confirm
              label={t("admin.cancelUpload")}
              title={t("admin.cancelUploadConfirm")}
              onConfirm={async () => {
                await api(`/admin/uploads/${upload.id}`, "DELETE");
                setUpload(null);
                localStorage.removeItem("rave-upload");
              }}
            />
          )}
        </div>
        <Link to="/admin/integrations">{t("admin.addDrive")}</Link>
      </form>
    </>
  );
}
interface EditableMedia extends Media {
  primarySourceId?: string;
}
export function EditVideo() {
  const { t, label, number } = useI18n();
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
    [subLabel, setSubLabel] = useState<string>(localeNames.es),
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
      <h1>{m?.title ?? t("admin.editVideo")}</h1>
      <Notice error={q.error ?? error} />
      <Reauth />
      {m && (
        <>
          <p>
            {t("admin.mediaStatus", {
              publication: label("publication", m.publicationState),
              health: label("source", m.health),
              seconds: number(m.durationSeconds, { maximumFractionDigits: 1 }),
            })}
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
              {t("media.title")}
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </label>
            <label>
              {t("media.description")}
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label>
              {t("media.category")}
              <input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              />
            </label>
            <button>{t("admin.saveMetadata")}</button>
            <label>
              {t("admin.replacePoster")}
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
              {t("admin.publish")}
            </button>
            <button onClick={() => void action(`videos/${id}/withdraw`)}>
              {t("admin.withdraw")}
            </button>
            {m.sourceKind === "local" && (
              <button onClick={() => void action(`videos/${id}/hls`)}>
                {t("admin.prepareHls")}
              </button>
            )}
            <Confirm
              label={t("admin.deleteVideo")}
              title={t("admin.deleteVideoConfirm")}
              onConfirm={async () => {
                await api(`/admin/videos/${id}`, "DELETE");
                navigate("/admin/videos");
              }}
            >
              {t("admin.deleteVideoHelp")}
            </Confirm>
          </div>
          {m.primarySourceId && m.sourceKind === "drive" && (
            <button
              onClick={() =>
                void action(`sources/${m.primarySourceId}/recheck`)
              }
            >
              {t("source.recheck")}
            </button>
          )}
          {m.primarySourceId &&
            m.sourceKind !== "local" &&
            m.sourceKind !== "drive" && (
              <section className={classes("panel")}>
                <h2>{t("source.label")}</h2>
                <label>
                  {t("source.newLink")}
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
                  {t("source.sameContent")}
                </label>
                <button
                  onClick={() =>
                    void action(`sources/${m.primarySourceId}`, "PATCH", {
                      url,
                      sameContent: same,
                    })
                  }
                >
                  {t("source.replaceVerify")}
                </button>
                <button
                  onClick={() =>
                    void action(`sources/${m.primarySourceId}/recheck`)
                  }
                >
                  {t("source.recheck")}
                </button>
                <Confirm
                  label={t("source.prepareCopy")}
                  title={t("source.copyConfirm")}
                  onConfirm={() =>
                    action(
                      `sources/${m.primarySourceId}/prepare-copy`,
                      "POST",
                      { authorized: true },
                    )
                  }
                >
                  {t("source.copyHelp")}
                </Confirm>
              </section>
            )}
          <section className={classes("panel")}>
            <h2>{t("player.subtitles")}</h2>
            <label>
              {t("admin.subtitleFile")}
              <input
                type="file"
                accept=".srt,.vtt"
                onChange={(e) => setSubfile(e.target.files?.[0] ?? null)}
              />
            </label>
            <label>
              {t("common.name")}
              <input
                value={subLabel}
                onChange={(e) => setSubLabel(e.target.value)}
              />
            </label>
            <label>
              {t("admin.subtitleLanguage")}
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
              {t("admin.addSubtitles")}
            </button>
          </section>
          <section className={classes("panel")}>
            <h2>{t("player.chapters")}</h2>
            <label>
              {t("admin.chapterFormat")}
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
              {t("admin.saveChapters")}
            </button>
          </section>
        </>
      )}
    </>
  );
}
export function Accounts() {
  const { t, label } = useI18n();
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
      <h1>{t("admin.twoAccounts")}</h1>
      <Reauth />
      <Notice error={q.error ?? error} />
      {q.data?.map((u) => (
        <section className={classes("panel")} key={u.id}>
          <h2>{u.displayName}</h2>
          <p>
            {u.username}
            {" · "}
            {label("role", u.role)}
            {" · "}
            {u.disabled ? t("admin.accountDisabled") : t("admin.accountActive")}
          </p>
          <label>
            {t("account.displayName")}
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
                label={u.disabled ? t("admin.reactivate") : t("admin.disable")}
                title={t("admin.accountAccessConfirm")}
                onConfirm={() =>
                  action(u.id, "", "PATCH", { disabled: !u.disabled })
                }
              >
                {t("admin.disableHelp")}
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
              {t("admin.issueReset")}
            </button>
            <Confirm
              label={t("admin.revokeSessions")}
              title={t("admin.revokeSessionsConfirm")}
              onConfirm={() => action(u.id, "/revoke-sessions")}
            />
          </div>
        </section>
      ))}
      {reset && (
        <section className={classes("panel")}>
          <p>{t("admin.resetLinkHelp")}</p>
          <input aria-label={t("admin.resetLink")} value={reset} readOnly />
          <button onClick={() => setReset("")}>{t("admin.hideLink")}</button>
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
export function SystemPage({
  storage = false,
  embedded = false,
}: {
  storage?: boolean;
  embedded?: boolean;
}) {
  const { t, label, number } = useI18n();
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
      {!embedded && <AdminNav />}
      {!embedded && (
        <h1>{storage ? t("admin.storageJobs") : t("admin.system")}</h1>
      )}
      <Notice error={q.error ?? jobs.error ?? error} />
      <Reauth />
      {q.data && (
        <section className={classes("panel")}>
          <h2>{t("storage.actual")}</h2>
          <p>
            {t("storage.summary", {
              free: number(Number(q.data.storage.freeBytes) / 1024 ** 3, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              }),
              assets: number(Number(q.data.storage.assetBytes) / 1024 ** 3, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              }),
            })}
          </p>
          <p>
            {t("storage.backupInfo", {
              mode: label("environment", q.data.mode),
              location: q.data.backupLocation,
            })}
          </p>
        </section>
      )}
      {!storage && (
        <section className={classes("panel")}>
          <h2>{t("admin.chatRetention")}</h2>
          <label>
            {t("admin.days")}
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
            {t("common.save")}
          </button>
          <Confirm
            label={t("admin.clearChat")}
            title={t("admin.clearChatConfirm")}
            onConfirm={() => api("/admin/room/chat", "DELETE")}
          >
            {t("admin.clearChatHelp")}
          </Confirm>
          <h2>{t("admin.operations")}</h2>
          <p>{t("admin.operationsHelp")}</p>
        </section>
      )}
      <h2>{t("admin.jobs")}</h2>
      {jobs.data?.map((j) => (
        <section className={classes("panel")} key={j.id}>
          <h3>{label("job", j.kind)}</h3>
          <p>
            {label("job", j.state)}{" "}
            {j.safe_error_code ? errorText(t, { code: j.safe_error_code }) : ""}
          </p>
          <progress
            aria-label={t("admin.processing")}
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
                {t("common.retry")}
              </button>
            )}
            {["queued", "running"].includes(j.state) && (
              <button
                onClick={() =>
                  void api(`/admin/jobs/${j.id}/cancel`, "POST").catch(setError)
                }
              >
                {t("common.cancel")}
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
  const { t, date } = useI18n();
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
      script.onerror = () => reject(new ApiError("PICKER_LOAD_FAILED"));
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
      <h1>{t("admin.drive")}</h1>
      <Reauth />
      <Notice error={q.error ?? error} />
      <section className={classes("panel")}>
        <h2>
          {!q.data?.configured
            ? t("drive.needsConfig")
            : q.data.authorized
              ? t("drive.authorized")
              : t("drive.needsAuth")}
        </h2>
        <p>{t("drive.pickerHelp")}</p>
        <p>
          {t("drive.liveTest", {
            date: q.data?.liveVerifiedAt
              ? date(q.data.liveVerifiedAt, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })
              : t("drive.notVerified"),
          })}
        </p>
        {!q.data?.configured ? (
          <p>{t("drive.configHelp")}</p>
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
              {q.data.authorized ? t("drive.reconnect") : t("drive.connect")}
            </button>
            {q.data.authorized && (
              <>
                <button onClick={() => void picker().catch(setError)}>
                  {t("drive.choose")}
                </button>
                <Confirm
                  label={t("drive.disconnect")}
                  title={t("drive.disconnectConfirm")}
                  onConfirm={() =>
                    api("/admin/drive/connection", "DELETE").then(() =>
                      q.refetch(),
                    )
                  }
                >
                  {t("drive.disconnectHelp")}
                </Confirm>
              </>
            )}
          </div>
        )}
        <p>{t("drive.testingHelp")}</p>
      </section>
    </>
  );
}
