import { useEffect, useState, useRef } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, time } from "../../app/api";
import { useAuth } from "../../app/auth";
import { useI18n } from "../../i18n/provider";
import { classes } from "../../styles/classes";
import { Notice, Confirm } from "../../components/common";
import { uploadFileChunks, type TransferStatus } from "../admin/upload-client";
import type { UploadRecord } from "../../../../../packages/contracts/src/upload-pipeline";
interface Upload {
  id: string;
  mediaId: string;
  offset: number;
  expectedBytes: number;
  name?: string;
}
export function Uploader({ admin = false }: { admin?: boolean }) {
  const { user } = useAuth();
  const base = admin ? "/admin/uploads" : "/uploads";
  const storageKey = `rave-upload:${user!.id}`;
  const draftPath = (mediaId: string, uploadId: string) =>
    admin ? `/admin/videos/${mediaId}` : `/my-uploads/${uploadId}`;
  const clearPointer = () => {
    try {
      localStorage.removeItem(storageKey);
      if (admin) localStorage.removeItem("rave-upload");
    } catch {
      /* Server state remains authoritative. */
    }
  };
  const { t, label, number } = useI18n();
  const navigate = useNavigate(),
    cache = useQueryClient(),
    [params] = useSearchParams(),
    controller = useRef<AbortController | null>(null),
    creation = useRef<{ body: string; key: string; file: File } | null>(null),
    mounted = useRef(true),
    [transfer, setTransfer] = useState<TransferStatus | null>(null),
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
        return JSON.parse(
          localStorage.getItem(storageKey) ??
            (admin ? localStorage.getItem("rave-upload") : null) ??
            "null",
        );
      } catch {
        return null;
      }
    });
  const finishUpload = async (mediaId: string, uploadId: string) => {
    clearPointer();
    if (mounted.current) setUpload(null);
    await cache.invalidateQueries({ queryKey: ["library"] });
    await cache.invalidateQueries({ queryKey: ["my-uploads", user!.id] });
    if (mounted.current) navigate(draftPath(mediaId, uploadId));
  };
  const resumeId = params.get("upload") ?? upload?.id;
  const resume = useQuery({
    queryKey: ["upload", user!.id, base, resumeId],
    queryFn: () => api<UploadRecord>(`${base}/${resumeId}`),
    enabled: !!resumeId,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (!resume.data) return;
    const record = resume.data;
    if (record.state === "completed") {
      void finishUpload(record.mediaId, record.id);
      return;
    }
    setUpload({ ...record });
    setTitle(record.title);
    setDescription(record.description);
    setCategory(record.category ?? "");
    setProgress(record.offset / record.expectedBytes);
  }, [resume.data?.id, resume.data?.state]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  const uploadFile = async () => {
    if (!file) throw new ApiError("UPLOAD_FILE_REQUIRED");
    let u = upload;
    if (u && u.expectedBytes !== file.size)
      throw new ApiError("UPLOAD_SIZE_MISMATCH");
    if (!u) {
      const body = {
        title,
        description,
        category: category || null,
        originalName: file.name,
        expectedBytes: file.size,
      };
      const fingerprint = JSON.stringify(body);
      if (
        creation.current?.body !== fingerprint ||
        creation.current.file !== file
      )
        creation.current = {
          body: fingerprint,
          key: crypto.randomUUID(),
          file,
        };
      // Retrying a lost creation response is the same intent, never filename deduplication.
      u = await api<Upload>(base, "POST", body, creation.current.key);
      u.name = file.name;
      setUpload(u);
      try {
        localStorage.setItem(storageKey, JSON.stringify(u));
      } catch {
        /* Resume is also available from the draft. */
      }
    }
    const completed = await uploadFileChunks(
      u,
      file,
      controller.current!.signal,
      (status) => {
        setTransfer(status);
        setProgress(status.sentBytes / file.size);
      },
      base,
    );
    await finishUpload(completed.mediaId, u.id);
  };
  return (
    <>
      <h1>{t(admin ? "admin.addVideo" : "uploads.upload")}</h1>
      <p>{t(admin ? "admin.draftHelp" : "uploads.help")}</p>
      <Notice error={error ?? resume.error} />
      <form
        className={classes("panel")}
        onSubmit={(e) => {
          e.preventDefault();
          if (controller.current) return;
          controller.current = new AbortController();
          setError(undefined);
          setBusy(true);
          void (
            !admin || file || upload
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
            .catch((error) => {
              if (!(
                error instanceof ApiError && error.code === "UPLOAD_PAUSED"
              ))
                setError(error);
            })
            .finally(() => {
              controller.current = null;
              setBusy(false);
            });
        }}
      >
        <label>
          {t("media.title")}
          <input
            value={title}
            disabled={busy || (!admin && !!upload)}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={200}
          />
        </label>
        <label>
          {t("media.description")}
          <textarea
            value={description}
            disabled={busy || (!admin && !!upload)}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={4000}
          />
        </label>
        <label>
          {t("media.category")}
          <input
            value={category}
            disabled={busy || (!admin && !!upload)}
            onChange={(e) => setCategory(e.target.value)}
            maxLength={80}
          />
        </label>
        <label>
          {t("source.local")}
          <input
            type="file"
            disabled={busy}
            accept="video/*,.mkv"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, ""));
            }}
          />
        </label>
        {upload && <p>{t("admin.resumeHelp", { name: upload.name ?? "—" })}</p>}
        {admin && (
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
        )}
        {admin && url && !file && !upload && (
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
        {(file || upload) && (
          <section aria-label={t("upload.transfer")}>
            <h2>{t("upload.transfer")}</h2>
            <progress aria-label={t("admin.upload")} max={1} value={progress} />
            <p>
              {t("upload.bytes", {
                sent: number(transfer?.sentBytes ?? upload?.offset ?? 0),
                total: number(file?.size ?? upload?.expectedBytes ?? 0),
                percent: number(progress, {
                  style: "percent",
                  maximumFractionDigits: 0,
                }),
              })}
            </p>
            <p>
              {t("upload.confirmed", {
                bytes: number(transfer?.confirmedBytes ?? upload?.offset ?? 0),
              })}
            </p>
            {transfer?.averageBytesPerSecond != null &&
            transfer.currentBytesPerSecond != null ? (
              <p>
                {t("upload.speed", {
                  current: number(transfer.currentBytesPerSecond / 1024 ** 2, {
                    maximumFractionDigits: 1,
                  }),
                  average: number(transfer.averageBytesPerSecond / 1024 ** 2, {
                    maximumFractionDigits: 1,
                  }),
                })}
              </p>
            ) : (
              busy && <p>{t("upload.measuring")}</p>
            )}
            {transfer?.remainingSeconds != null && (
              <p>
                {t("upload.remaining", {
                  time: time(Math.ceil(transfer.remainingSeconds)),
                })}
              </p>
            )}
            <p>{t("upload.separateProgress")}</p>
            {transfer?.phase === "finalizing" && (
              <p role="status">{t("upload.finalizing")}</p>
            )}
            {transfer?.phase === "paused" && (
              <p role="status">{t("upload.paused")}</p>
            )}
            {busy && transfer?.phase !== "finalizing" && (
              <button type="button" onClick={() => controller.current?.abort()}>
                {t("upload.pause")}
              </button>
            )}
            {upload && (
              <Link to={draftPath(upload.mediaId, upload.id)}>
                {t("upload.viewDraft")}
              </Link>
            )}
          </section>
        )}
        <div className={classes("actions")}>
          <button
            disabled={busy || (!file && !upload && !inspection)}
            className={classes("primary")}
          >
            {busy
              ? transfer?.phase === "finalizing"
                ? t("upload.finalizing")
                : t("admin.uploading", {
                    percent: number(progress, {
                      style: "percent",
                      maximumFractionDigits: 0,
                    }),
                  })
              : upload
                ? t("admin.resumeUpload")
                : t(admin ? "admin.createDraft" : "uploads.upload")}
          </button>
          {upload && (
            <Confirm
              label={t("admin.cancelUpload")}
              title={t("admin.cancelUploadConfirm")}
              onConfirm={async () => {
                controller.current?.abort();
                await api(`${base}/${upload.id}`, "DELETE");
                setUpload(null);
                setTransfer(null);
                setProgress(0);
                creation.current = null;
                cache.removeQueries({
                  queryKey: ["upload", user!.id, base, upload.id],
                });
                await cache.invalidateQueries({
                  queryKey: ["my-uploads", user!.id],
                });
                clearPointer();
                if (params.has("upload"))
                  navigate(admin ? "/admin/videos/new" : "/upload", {
                    replace: true,
                  });
              }}
            />
          )}
        </div>
        {admin && <Link to="/admin/integrations">{t("admin.addDrive")}</Link>}
      </form>
    </>
  );
}
