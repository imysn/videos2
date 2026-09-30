import { classes } from "../../styles/classes";
import { ui } from "../../i18n/es";
import { useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api, time, type Media } from "../../app/api";
import { useAuth } from "../../app/auth";
import { Notice, Empty, Confirm } from "../../components/common";
export function Library({ admin = false }: { admin?: boolean }) {
  const { user } = useAuth(),
    [params, setParams] = useSearchParams(),
    search = params.get("search") ?? "",
    pending = params.get("pending") === "true",
    sort = params.get("sort") ?? "recent",
    category = params.get("category") ?? "";
  const q = useInfiniteQuery({
    queryKey: ["library", admin, search, pending, sort, category],
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      api<{ items: Media[]; nextCursor: string | null }>(
        `${admin ? "/admin/videos" : "/library"}?${new URLSearchParams({ search, pending: String(pending), sort, ...(category ? { category } : {}), ...(pageParam ? { cursor: pageParam } : {}) })}`,
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const set = (key: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(key, v);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <div className={classes("heading")}>
        <div>
          <p className={classes("eyebrow")}>{ui.vuestro_espacio_3e8d59}</p>
          <h1>{admin ? "Contenido" : "Biblioteca"}</h1>
        </div>
        {admin && (
          <Link className={classes("button primary")} to="/admin/videos/new">
            {ui.anadir_video_d471c2}
          </Link>
        )}
      </div>
      <div className={classes("filters")}>
        <label>
          {ui.buscar_5f55ed}
          <input
            type="search"
            value={search}
            onChange={(e) => set("search", e.target.value)}
            placeholder={ui.titulo_o_descripcion_b62e62}
          />
        </label>
        <label>
          {ui.categoria_558bb2}
          <input
            value={category}
            onChange={(e) => set("category", e.target.value)}
          />
        </label>
        <label>
          {ui.orden_997dfc}
          <select value={sort} onChange={(e) => set("sort", e.target.value)}>
            <option value="recent">{ui.mas_recientes_2ad745}</option>
            <option value="title">{ui.titulo_4c08a5}</option>
          </select>
        </label>
        <label className={classes("check")}>
          <input
            type="checkbox"
            checked={pending}
            onChange={(e) => set("pending", String(e.target.checked))}
          />
          {ui.pendientes_bb6e43}
        </label>
      </div>
      <Notice error={q.error} />
      {q.isPending && <p role="status">{ui.cargando_biblioteca_daf2f4}</p>}
      {!q.isPending && !items.length && (
        <Empty>
          <h2>{ui.aun_no_hay_videos_aqui_9fffb7}</h2>
          <p>
            {user?.role === "OWNER"
              ? "Añade un archivo propio, un enlace compatible o un vídeo de Drive."
              : "Jason puede añadir vídeos a vuestra biblioteca."}
          </p>
          {user?.role === "OWNER" && (
            <Link className={classes("button")} to="/admin/videos/new">
              {ui.anadir_video_d471c2}
            </Link>
          )}
        </Empty>
      )}
      <div className={classes("catalog")}>
        {items.map((m) => (
          <Link
            className={classes("card")}
            key={m.id}
            to={admin ? `/admin/videos/${m.id}` : `/video/${m.id}`}
          >
            <div className={classes("poster")}>
              {m.posterUrl ? (
                <img loading="lazy" src={m.posterUrl} alt="" />
              ) : (
                <span aria-hidden="true">{ui._cbf256}</span>
              )}
              <span className={classes("duration")}>
                {time(m.durationSeconds)}
              </span>
            </div>
            <h2>{m.title}</h2>
            <p>
              {m.category ?? "Sin categoría"}
              {ui._78887d} {m.health === "READY" ? "Disponible" : m.health}
            </p>
            {admin && <p>{m.publicationState}</p>}
            {m.personalPosition > 0 && (
              <progress
                aria-label={ui.progreso_personal_0247fa}
                value={m.personalPosition}
                max={m.durationSeconds}
              />
            )}
            <small>
              {m.sharedPosition > 0
                ? `Juntos: ${time(m.sharedPosition)}`
                : m.pending
                  ? "Pendiente"
                  : ""}
            </small>
          </Link>
        ))}
      </div>
      {q.hasNextPage && (
        <button onClick={() => void q.fetchNextPage()}>
          {ui.ver_mas_6044f3}
        </button>
      )}
    </>
  );
}
export function Detail() {
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
        <p>{ui.cargando_video_0cc504}</p>
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
        <Link to="/">{ui.biblioteca_b62f2b}</Link>
        <p className={classes("eyebrow")}>{m.category ?? "VUESTRO CATÁLOGO"}</p>
        <h1>{m.title}</h1>
        <p>{m.description}</p>
        <p>
          {time(m.durationSeconds)}
          {ui._78887d}{" "}
          {m.sourceKind === "drive"
            ? "Google Drive"
            : m.sourceKind === "local"
              ? "Archivo propio"
              : "Enlace autorizado"}{" "}
          {ui._6e01f7}
          {m.health === "READY" ? "Disponible" : m.health}
        </p>
        <Notice error={error} />
        <div className={classes("actions")}>
          <Link className={classes("button")} to={`/watch/${m.id}`}>
            {ui.ver_solo_2790ef}
          </Link>
          {m.personalPosition > 0 ? (
            <Confirm
              label={ui.ver_juntos_004480}
              title={ui.elegir_punto_de_inicio_839227}
              onConfirm={() => start(false)}
            >
              <p>{ui.se_usara_el_progreso_compartido_afde31}</p>
              <button onClick={() => void start(true).catch(setError)}>
                {ui.empezar_desde_mi_punto_4b0e0b}
                {time(m.personalPosition)}
                {ui._ba5ec5}
              </button>
            </Confirm>
          ) : (
            <button
              className={classes("primary")}
              onClick={() => void start().catch(setError)}
            >
              {ui.ver_juntos_004480}
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
            {m.pending ? "Quitar de pendientes" : "Añadir a pendientes"}
          </button>
        </div>
        <p>
          {ui.solo_fa1afd}
          {time(m.personalPosition)}
          {ui.juntos_d8df94}
          {time(m.sharedPosition)}
        </p>
      </div>
    </section>
  );
}
