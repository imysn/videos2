import { useI18n } from "../../i18n/provider";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { PlaybackDescriptor } from "../../../../../packages/contracts/src/protocol";
import { api, clientId, ApiError, csrfToken, type Media } from "../../app/api";
import type { EngineAdapter } from "../../player/engines";
import { Player } from "../../player/Player";
import { Notice } from "../../components/common";
interface Solo {
  id: string;
  positionSeconds: number;
  writeRevision: number;
  contentGeneration: string;
}
export function SoloPage() {
  const { t } = useI18n();
  const { id } = useParams(),
    [data, setData] = useState<{
      media: Media;
      descriptor: PlaybackDescriptor;
      solo: Solo;
    }>(),
    [error, setError] = useState<unknown>(),
    currentEngine = useRef<EngineAdapter | null>(null),
    latest = useRef(0),
    revision = useRef(0),
    queue = useRef(Promise.resolve()),
    requestGeneration = useRef(0),
    mounted = useRef(true),
    closedSessions = useRef(new Set<string>());
  const load = async (takeover = false) => {
    setError(undefined);
    setData(undefined);
    const generation = ++requestGeneration.current;
    const [media, descriptor, solo] = await Promise.all([
      api<Media>(`/media/${id}`),
      api<PlaybackDescriptor>(`/playback/${id}/resolve`, "POST"),
      api<Solo>("/solo-sessions", "POST", {
        mediaId: id,
        clientInstanceId: clientId(),
        takeover,
      }),
    ]);
    if (!mounted.current || generation !== requestGeneration.current) {
      await api(`/solo-sessions/${solo.id}/end`, "POST", {
        positionSeconds: solo.positionSeconds,
        writeRevision: solo.writeRevision + 1,
        contentGeneration: solo.contentGeneration,
      });
      return;
    }
    revision.current = solo.writeRevision;
    setData({ media, descriptor, solo });
  };
  useEffect(() => {
    mounted.current = true;
    const generation = requestGeneration.current + 1;
    void load().catch((e) => {
      if (mounted.current && generation === requestGeneration.current)
        setError(e);
    });
    return () => {
      mounted.current = false;
      requestGeneration.current++;
    };
  }, [id]);
  const save = (position: number, end = false) => {
    latest.current = position;
    if (
      !data ||
      closedSessions.current.has(data.solo.id) ||
      !Number.isFinite(position)
    )
      return;
    const body = {
      positionSeconds: position,
      writeRevision: ++revision.current,
      contentGeneration: data.solo.contentGeneration,
    };
    queue.current = queue.current
      .then(() =>
        api(
          `/solo-sessions/${data.solo.id}/${end ? "end" : "progress"}`,
          end ? "POST" : "PUT",
          body,
        ),
      )
      .then(() => {})
      .catch((e) => {
        if (mounted.current && !closedSessions.current.has(data.solo.id))
          setError(e);
      });
  };
  useEffect(() => {
    if (!data) return;
    const end = () => {
      if (closedSessions.current.has(data.solo.id)) return;
      closedSessions.current.add(data.solo.id);
      const body = {
        positionSeconds: currentEngine.current?.getPosition() ?? latest.current,
        writeRevision: ++revision.current,
        contentGeneration: data.solo.contentGeneration,
      };
      void fetch(`/api/v1/solo-sessions/${data.solo.id}/end`, {
        method: "POST",
        keepalive: true,
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken(),
        },
        body: JSON.stringify(body),
      });
    };
    window.addEventListener("pagehide", end);
    const timer = setInterval(
      () => save(currentEngine.current?.getPosition() ?? latest.current),
      10000,
    );
    return () => {
      clearInterval(timer);
      window.removeEventListener("pagehide", end);
      end();
    };
  }, [data?.solo.id]);
  return (
    <>
      <Link to={`/video/${id}`}>{t("watch.back")}</Link>
      <h1>{data?.media.title ?? t("watch.solo")}</h1>
      <Notice error={error} />
      {!data &&
        error instanceof ApiError &&
        error.code === "SOLO_DEVICE_ACTIVE" && (
          <button onClick={() => void load(true).catch(setError)}>
            {t("room.useDevice")}
          </button>
        )}
      {data && (
        <Player
          descriptor={data.descriptor}
          media={data.media}
          initialPosition={data.solo.positionSeconds}
          onProgress={(p) => save(p)}
          onEngine={(e) => {
            currentEngine.current = e;
            if (e) latest.current = data.solo.positionSeconds;
          }}
        />
      )}
    </>
  );
}
