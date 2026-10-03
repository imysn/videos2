import { classes } from "../../styles/classes";
import { useI18n } from "../../i18n/provider";
import { useEffect, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
  useLocation,
  useNavigationType,
} from "react-router-dom";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api, time, type Media } from "../../app/api";
import { useAuth } from "../../app/auth";
import { Notice, Empty, Confirm } from "../../components/common";
import { watched } from "../../../../../packages/contracts/src/index";
import { PreparationSummary, preparationActive } from "../admin/UploadStatus";
const libraryPositions = new Map<string, { scroll: number; focus: string }>();
export function Library({ admin = false }: { admin?: boolean }) {
  const { t, label } = useI18n();
  const location = useLocation(),
    navigation = useNavigationType(),
    libraryPath = location.pathname + location.search;
  const { user } = useAuth(),
    [params, setParams] = useSearchParams(),
    search = params.get("search") ?? "",
    pending = params.get("pending") === "true",
    sort = params.get("sort") ?? "recent",
    category = params.get("category") ?? "",
    publication = admin ? (params.get("publication") ?? "all") : "all";
  const q = useInfiniteQuery({
    queryKey: ["library", admin, search, pending, sort, category, publication],
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      api<{ items: Media[]; nextCursor: string | null }>(
        `${admin ? "/admin/videos" : "/library"}?${new URLSearchParams({ search, pending: String(pending), sort, ...(admin ? { publication } : {}), ...(category ? { category } : {}), ...(pageParam ? { cursor: pageParam } : {}) })}`,
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    refetchInterval: (query) =>
      admin &&
      query.state.data?.pages.some((page) =>
        page.items.some((m) => preparationActive(m.preparation)),
      )
        ? 5000
        : false,
  });
  const set = (key: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(key, v);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  useEffect(() => {
    if (
      q.isPending ||
      !(navigation === "POP" || location.state?.restoreLibrary)
    )
      return;
    const previous = libraryPositions.get(libraryPath);
    if (!previous) return;
    const frame = requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-media-id="${previous.focus}"]`)
        ?.focus({ preventScroll: true });
      window.scrollTo(0, previous.scroll);
    });
    return () => cancelAnimationFrame(frame);
  }, [q.isPending, libraryPath, navigation, location.state]);
  return (
    <>
      <div className={classes("heading")}>
        <div>
          <p className={classes("eyebrow")}>{t("library.space")}</p>
          <h1>{admin ? t("admin.content") : t("nav.library")}</h1>
        </div>
        {admin && (
          <Link className={classes("button primary")} to="/admin/videos/new">
            {t("admin.addVideo")}
          </Link>
        )}
      </div>
      <div className={classes("filters")}>
        {admin && (
          <label>
            {t("upload.contentFilter")}
            <select
              value={publication}
              onChange={(e) => set("publication", e.target.value)}
            >
              <option value="all">{t("upload.allContent")}</option>
              <option value="preparing">{t("upload.preparingContent")}</option>
              <option value="published">{t("upload.publishedContent")}</option>
            </select>
          </label>
        )}
        <label>
          {t("library.search")}
          <input
            type="search"
            value={search}
            onChange={(e) => set("search", e.target.value)}
            placeholder={t("library.searchPlaceholder")}
          />
        </label>
        <label>
          {t("media.category")}
          <input
            value={category}
            onChange={(e) => set("category", e.target.value)}
          />
        </label>
        <label>
          {t("library.sort")}
          <select value={sort} onChange={(e) => set("sort", e.target.value)}>
            <option value="recent">{t("library.recent")}</option>
            <option value="title">{t("media.title")}</option>
          </select>
        </label>
        <label className={classes("check")}>
          <input
            type="checkbox"
            checked={pending}
            onChange={(e) => set("pending", String(e.target.checked))}
          />
          {t("library.pending")}
        </label>
      </div>
      <Notice error={q.error} />
      {q.isPending && <p role="status">{t("library.loading")}</p>}
      {!q.isPending && !items.length && (
        <Empty>
          <h2>{t("library.empty")}</h2>
          <p>
            {user?.role === "OWNER"
              ? t("library.emptyOwner")
              : t("library.emptyPartner")}
          </p>
          {user?.role === "OWNER" && (
            <Link className={classes("button")} to="/admin/videos/new">
              {t("admin.addVideo")}
            </Link>
          )}
        </Empty>
      )}
      <div className={classes("catalog")}>
        {items.map((m) => (
          <Link
            className={classes("card")}
            key={m.id}
            data-media-id={m.id}
            state={{ libraryPath }}
            onClick={() =>
              libraryPositions.set(libraryPath, {
                scroll: window.scrollY,
                focus: m.id,
              })
            }
            to={admin ? `/admin/videos/${m.id}` : `/video/${m.id}`}
          >
            <div className={classes("poster")}>
              {m.posterUrl ? (
                <img loading="lazy" src={m.posterUrl} alt="" />
              ) : (
                <span aria-hidden="true">{"▷"}</span>
              )}
              <span className={classes("duration")}>
                {time(m.durationSeconds)}
              </span>
            </div>
            <h2>{m.title}</h2>
            <p>
              {m.category ?? t("library.noCategory")}
              {" ·"} {label("source", m.health)}
            </p>
            {admin && <p>{label("publication", m.publicationState)}</p>}
            {admin && m.preparation && (
              <PreparationSummary preparation={m.preparation} />
            )}
            {m.watched && <small>{t("library.watched")}</small>}
            {watched(m.personalPosition, m.durationSeconds) && (
              <small>{t("library.watchedSolo")}</small>
            )}
            {watched(m.sharedPosition, m.durationSeconds) && (
              <small>{t("library.watchedTogether")}</small>
            )}
            {m.personalPosition > 0 && (
              <progress
                aria-label={t("library.personalProgress")}
                value={m.personalPosition}
                max={m.durationSeconds}
              />
            )}
            <small>
              {m.sharedPosition > 0
                ? t("watch.sharedProgress", { time: time(m.sharedPosition) })
                : m.pending
                  ? t("library.pending")
                  : ""}
            </small>
          </Link>
        ))}
      </div>
      {q.hasNextPage && (
        <button onClick={() => void q.fetchNextPage()}>
          {t("library.more")}
        </button>
      )}
    </>
  );
}
export function Detail() {
  const { t, label } = useI18n();
  const location = useLocation(),
    returnPath =
      typeof location.state?.libraryPath === "string"
        ? location.state.libraryPath
        : "/";
  const { id } = useParams(),
    navigate = useNavigate(),
    cache = useQueryClient(),
    [error, setError] = useState<unknown>();
  const q = useQuery({
    queryKey: ["media", id],
    queryFn: () => api<Media>(`/media/${id}`),
  });
  const m = q.data;
  if (!m)
    return (
      <>
        <Notice error={q.error} />
        <p>{t("library.loadingVideo")}</p>
      </>
    );
  const start = async (personal = false) => {
    await api("/room/start", "POST", {
      mediaId: m.id,
      ...(personal ? { personalPositionSeconds: m.personalPosition } : {}),
    });
    navigate("/room");
  };
  return (
    <section className={classes("detail")}>
      <div className={classes("detailPoster")}>
        {m.posterUrl && <img src={m.posterUrl} alt="" />}
      </div>
      <div>
        <Link to={returnPath} state={{ restoreLibrary: true }}>
          {t("library.back")}
        </Link>
        <p className={classes("eyebrow")}>
          {m.category ?? t("library.catalogue")}
        </p>
        <h1>{m.title}</h1>
        <p>{m.description}</p>
        <p>
          {time(m.durationSeconds)}
          {" ·"}{" "}
          {m.sourceKind === "drive"
            ? t("admin.drive")
            : m.sourceKind === "local"
              ? t("source.local")
              : t("source.authorized")}{" "}
          {"· "}
          {label("source", m.health)}
        </p>
        <Notice error={error} />
        <div className={classes("actions")}>
          <Link className={classes("button")} to={`/watch/${m.id}`}>
            {t("watch.solo")}
          </Link>
          {m.personalPosition > 0 ? (
            <Confirm
              label={t("watch.together")}
              title={t("watch.startChoice")}
              onConfirm={() => start(false)}
            >
              <p>{t("watch.startHelp")}</p>
              <button onClick={() => void start(true).catch(setError)}>
                {t("watch.startPersonal", { time: time(m.personalPosition) })}
              </button>
            </Confirm>
          ) : (
            <button
              className={classes("primary")}
              onClick={() => void start().catch(setError)}
            >
              {t("watch.together")}
            </button>
          )}
          <button
            onClick={() =>
              void api(
                `/watchlist/${m.id}`,
                m.pending ? "DELETE" : "PUT",
                m.pending ? {} : { watched: false },
              )
                .then(() =>
                  cache.invalidateQueries({ queryKey: ["media", id] }),
                )
                .catch(setError)
            }
          >
            {m.pending ? t("library.removePending") : t("library.addPending")}
          </button>
          <button
            onClick={() =>
              void api(`/watchlist/${m.id}`, "PUT", { watched: !m.watched })
                .then(() =>
                  cache.invalidateQueries({ queryKey: ["media", id] }),
                )
                .catch(setError)
            }
          >
            {m.watched ? t("library.markUnwatched") : t("library.markWatched")}
          </button>
        </div>
        <p>
          {t("watch.progress", {
            personal: time(m.personalPosition),
            shared: time(m.sharedPosition),
          })}
        </p>
      </div>
    </section>
  );
}
