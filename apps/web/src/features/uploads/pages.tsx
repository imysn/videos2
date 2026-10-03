import { Link, useParams } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { UserUpload } from "../../../../../packages/contracts/src/upload-pipeline";
import { api } from "../../app/api";
import { useAuth } from "../../app/auth";
import { Empty, Notice } from "../../components/common";
import { useI18n } from "../../i18n/provider";
import { classes } from "../../styles/classes";
import { Uploader } from "./Uploader";
import {
  PreparationStatus,
  PreparationSummary,
  preparationActive,
} from "../admin/UploadStatus";

function UploadsNav() {
  const { t } = useI18n();
  return (
    <nav className={classes("subnav")} aria-label={t("uploads.navigation")}>
      <Link to="/upload">{t("uploads.upload")}</Link>
      <Link to="/my-uploads">{t("uploads.mine")}</Link>
    </nav>
  );
}
function UploadMetadata({ upload }: { upload: UserUpload }) {
  const { t, date, number } = useI18n();
  return (
    <>
      <p>
        {date(upload.createdAt, { dateStyle: "medium", timeStyle: "short" })}
      </p>
      <p>{t("uploads.size", { bytes: number(upload.expectedBytes) })}</p>
    </>
  );
}
function WaitingPublication({ upload }: { upload: UserUpload }) {
  const { t } = useI18n();
  return upload.preparation.phase === "ready" ? (
    <>
      <p role="status">
        <strong>{t("uploads.waitingPublication")}</strong>
      </p>
      <p>{t("uploads.ownerPublishHelp", { name: upload.ownerDisplayName })}</p>
    </>
  ) : null;
}
export function UploadPage() {
  return (
    <>
      <UploadsNav />
      <Uploader />
    </>
  );
}
export function MyUploads() {
  const { t } = useI18n(),
    { user } = useAuth();
  const q = useInfiniteQuery({
    queryKey: ["my-uploads", user!.id],
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      api<{ items: UserUpload[]; nextCursor: string | null }>(
        pageParam
          ? `/uploads?${new URLSearchParams({ cursor: pageParam })}`
          : "/uploads",
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: (query) => {
      const items = query.state.data?.pages.flatMap((page) => page.items) ?? [];
      return items.some((u) => preparationActive(u.preparation))
        ? 5000
        : items.some((u) => u.preparation.phase === "ready")
          ? 15000
          : false;
    },
  });
  const items = q.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <>
      <UploadsNav />
      <h1>{t("uploads.mine")}</h1>
      <p>{t("uploads.scopeHelp")}</p>
      <Notice error={q.error} />
      {q.isPending && <p role="status">{t("uploads.loading")}</p>}
      {!q.isPending && !q.error && !items.length && (
        <Empty>{t("uploads.empty")}</Empty>
      )}
      <div className={classes("catalog")}>
        {items.map((u) => (
          <article
            key={u.id}
            className={classes("panel")}
            data-upload-id={u.id}
          >
            <h2>
              <Link to={`/my-uploads/${u.id}`}>{u.title}</Link>
            </h2>
            <UploadMetadata upload={u} />
            <p role="status">
              <PreparationSummary preparation={u.preparation} />
            </p>
            {u.preparation.phase === "processing" && (
              <progress
                aria-label={t("upload.processingProgress")}
                max={1}
                value={u.preparation.job?.progress ?? 0}
              />
            )}
            <Notice
              error={
                u.preparation.safeErrorCode
                  ? { code: u.preparation.safeErrorCode }
                  : null
              }
            />
            <WaitingPublication upload={u} />
          </article>
        ))}
      </div>
      {q.hasNextPage && (
        <button
          disabled={q.isFetchingNextPage}
          onClick={() => void q.fetchNextPage()}
        >
          {t("library.more")}
        </button>
      )}
    </>
  );
}
export function MyUpload() {
  const { id } = useParams(),
    { user } = useAuth(),
    { t } = useI18n();
  const q = useQuery({
    queryKey: ["my-upload", user!.id, id],
    queryFn: () => api<UserUpload>(`/uploads/${id}`),
    refetchInterval: (query) =>
      preparationActive(query.state.data?.preparation)
        ? 3000
        : query.state.data?.preparation.phase === "ready"
          ? 15000
          : false,
  });
  const u = q.data;
  return (
    <>
      <UploadsNav />
      <h1>{!q.error && u ? u.title : t("uploads.mine")}</h1>
      <Notice error={q.error} />
      {q.isPending && <p role="status">{t("uploads.loading")}</p>}
      {!q.error && u && (
        <>
          <p>{u.description}</p>
          {u.category && <p>{u.category}</p>}
          <UploadMetadata upload={u} />
          <PreparationStatus
            preparation={u.preparation}
            mediaId={u.mediaId}
            withdrawn={false}
            userUpload
          />
          <WaitingPublication upload={u} />
          {u.publicationState === "PUBLISHED" && (
            <Link to={`/video/${u.mediaId}`}>{t("app.backLibrary")}</Link>
          )}
        </>
      )}
    </>
  );
}
