import { classes } from "../styles/classes";
import { useI18n } from "../i18n/provider";
import styles from "./Player.module.css";
import { useEffect, useRef, useState } from "react";
import * as Slider from "@radix-ui/react-slider";
import * as Settings from "@radix-ui/react-dialog";
import type { PlaybackDescriptor } from "../../../../packages/contracts/src/protocol";
import { PLAYBACK_RATES } from "../../../../packages/contracts/src/protocol";
import { decodeCueText } from "../../../../packages/contracts/src/subtitle-text";
import { api, ApiError, time, type Media } from "../app/api";
import { useAuth } from "../app/auth";
import {
  NativeFileEngine,
  AdaptiveEngine,
  type EngineAdapter,
} from "./engines";
import { Notice } from "../components/common";
interface Props {
  descriptor: PlaybackDescriptor;
  media: Media;
  canControl?: boolean;
  room?: boolean;
  desiredPlayback?: "playing" | "paused";
  baseRate?: number;
  initialPosition?: number;
  onIntent?: (
    type: "PLAY" | "PAUSE" | "SEEK" | "SET_RATE",
    value?: number,
  ) => void;
  onEngine?: (e: EngineAdapter | null) => void;
  onProgress?: (n: number, ended: boolean) => void;
  diagnostics?: () => Record<string, string | number | boolean>;
}
interface Cue {
  start: number;
  end: number;
  text: string;
}
function cues(text: string): Cue[] {
  return text
    .replace(/\r/g, "")
    .split("\n\n")
    .flatMap((b) => {
      const lines = b.split("\n"),
        idx = lines.findIndex((l) => l.includes("-->"));
      if (idx < 0) return [];
      const parse = (s: string) =>
        s
          .trim()
          .split(":")
          .reduce((a, n) => a * 60 + Number(n.replace(",", ".")), 0);
      const [start, end] = lines[idx].split("-->");
      return [
        {
          start: parse(start),
          end: parse(end.split(" ")[1] ?? end),
          text: decodeCueText(
            lines
              .slice(idx + 1)
              .join("\n")
              .replace(/<[^>]*>/g, ""),
          ),
        },
      ];
    });
}
export function Player({
  descriptor,
  media,
  canControl = true,
  room = false,
  desiredPlayback,
  baseRate,
  initialPosition = 0,
  onIntent,
  onEngine,
  onProgress,
  diagnostics,
}: Props) {
  const { t, label, number } = useI18n();
  const { user } = useAuth(),
    v = useRef<HTMLVideoElement>(null),
    shell = useRef<HTMLDivElement>(null),
    engine = useRef<EngineAdapter | null>(null),
    teardown = useRef<Promise<void>>(Promise.resolve()),
    lastTap = useRef({ time: 0, x: 0 }),
    cancelledSeek = useRef(false),
    qualityPreference = useRef(String(user?.preferences.quality ?? "auto")),
    subtitleLanguagePreference = useRef(
      String(user?.preferences.subtitleLanguage ?? ""),
    ),
    lastSubtitle = useRef(
      media.subtitles?.some((s) => s.id === user?.preferences.subtitleId)
        ? String(user?.preferences.subtitleId)
        : "",
    ),
    handlers = useRef({ onEngine, onProgress, onIntent });
  handlers.current = { onEngine, onProgress, onIntent };
  const [error, setError] = useState<unknown>(),
    [playing, setPlaying] = useState(false),
    [position, setPosition] = useState(0),
    [duration, setDuration] = useState(descriptor.durationSeconds),
    [buffer, setBuffer] = useState(0),
    [volume, setVolume] = useState(Number(user?.preferences.volume ?? 0.8)),
    [muted, setMuted] = useState(Boolean(user?.preferences.muted)),
    [preview, setPreview] = useState<number | null>(null),
    [rate, setRate] = useState(1),
    [cinema, setCinema] = useState(false),
    [tracks, setTracks] = useState<ReturnType<EngineAdapter["listTracks"]>>([]),
    [quality, setQuality] = useState("auto"),
    [subtitle, setSubtitle] = useState(
      media.subtitles?.some((s) => s.id === user?.preferences.subtitleId)
        ? String(user?.preferences.subtitleId)
        : "",
    ),
    [offset, setOffset] = useState(
      Number(user?.preferences.subtitleOffset ?? 0),
    ),
    [size, setSize] = useState(Number(user?.preferences.subtitleSize ?? 100)),
    [background, setBackground] = useState(
      Boolean(user?.preferences.subtitleBackground ?? true),
    ),
    [audio, setAudio] = useState(""),
    [textCues, setTextCues] = useState<Cue[]>([]);
  const [engineText, setEngineText] = useState(""),
    subtitleOffset = useRef(offset);
  subtitleOffset.current = offset;
  const transportPlaying = room ? desiredPlayback === "playing" : playing;
  useEffect(() => {
    const video = v.current!;
    let cancelled = false;
    const e =
      descriptor.kind === "file"
        ? new NativeFileEngine(video)
        : new AdaptiveEngine(video);
    engine.current = e;
    setError(undefined);
    const metadata = () => {
      setDuration(video.duration);
      if (!room && initialPosition) e.seek(initialPosition);
    };
    video.addEventListener("loadedmetadata", metadata);
    const loading = teardown.current
      .then(() => {
        if (!cancelled) return e.load(descriptor);
      })
      .then(() => {
        if (!cancelled) {
          handlers.current.onEngine?.(e);
          setTracks(e.listTracks());
          const saved = e
            .listTracks()
            .find(
              (track) =>
                track.kind === "video" &&
                (`${track.height}p` === qualityPreference.current ||
                  track.id === qualityPreference.current),
            );
          if (saved) {
            e.selectTrack(saved.id);
            setQuality(saved.id);
          } else setQuality("auto");
          const text = subtitleLanguagePreference.current
            ? e
                .listTracks()
                .find(
                  (track) =>
                    track.kind === "subtitle" &&
                    track.language === subtitleLanguagePreference.current,
                )
            : undefined;
          if (text) {
            const value = `engine:${text.id}`;
            setSubtitle(value);
            lastSubtitle.current = value;
          }
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      });
    const interval = setInterval(() => {
      if (cancelled) return;
      setPosition(video.currentTime);
      setPlaying(!video.paused);
      setBuffer(e.getBuffered());
      setRate(video.playbackRate);
      setTracks(e.listTracks());
      setEngineText(e.subtitleAt(video.currentTime - subtitleOffset.current));
    }, 250);
    const ended = () => handlers.current.onProgress?.(video.currentTime, true);
    const paused = () => {
      if (!room) handlers.current.onProgress?.(video.currentTime, false);
    };
    const failed = () => setError(new ApiError("SOURCE_UNSUPPORTED"));
    video.addEventListener("ended", ended);
    video.addEventListener("pause", paused);
    video.addEventListener("error", failed);
    return () => {
      cancelled = true;
      clearInterval(interval);
      video.removeEventListener("loadedmetadata", metadata);
      video.removeEventListener("ended", ended);
      video.removeEventListener("pause", paused);
      video.removeEventListener("error", failed);
      handlers.current.onEngine?.(null);
      if (!room) handlers.current.onProgress?.(video.currentTime, false);
      teardown.current = Promise.allSettled([loading, e.destroy()]).then(
        () => {},
      );
      if (engine.current === e) engine.current = null;
    };
  }, [descriptor.sourceId, descriptor.contentGeneration, descriptor.url, room]);
  useEffect(() => {
    if (v.current) {
      v.current.volume = volume;
      v.current.muted = muted;
    }
  }, [volume, muted]);
  useEffect(() => {
    const timer = setTimeout(() => {
      void api("/account", "PATCH", {
        preferences: {
          volume,
          muted,
          quality: qualityPreference.current,
          subtitleId:
            subtitle && !subtitle.startsWith("engine:") ? subtitle : null,
          subtitleLanguage: subtitleLanguagePreference.current || null,
          subtitleOffset: offset,
          subtitleSize: size,
          subtitleBackground: background,
        },
      }).catch(setError);
    }, 600);
    return () => clearTimeout(timer);
  }, [volume, muted, quality, subtitle, offset, size, background]);
  useEffect(() => {
    engine.current?.selectTrack("text:off");
    if (subtitle.startsWith("engine:")) {
      engine.current?.selectTrack(subtitle.slice(7));
      setTextCues([]);
      return;
    }
    if (!subtitle) {
      setTextCues([]);
      return;
    }
    const s = media.subtitles?.find((s) => s.id === subtitle);
    if (!s) return;
    const c = new AbortController();
    void fetch(s.url, { signal: c.signal })
      .then((r) => {
        if (!r.ok) throw new ApiError("SUBTITLE_LOAD_FAILED");
        return r.text();
      })
      .then((t) => setTextCues(cues(t)))
      .catch((e) => {
        if (!c.signal.aborted) setError(e);
      });
    return () => c.abort();
  }, [subtitle, media.id]);
  const intent = (
    type: "PLAY" | "PAUSE" | "SEEK" | "SET_RATE",
    value?: number,
  ) => {
    if (!canControl) return;
    if (room) {
      handlers.current.onIntent?.(type, value);
      return;
    }
    const e = engine.current;
    if (!e) return;
    if (type === "PLAY")
      void e.play().catch(() => setError(new ApiError("AUTOPLAY_BLOCKED")));
    if (type === "PAUSE") e.pause();
    if (type === "SEEK") e.seek(value!);
    if (type === "SET_RATE") e.setRate(value!);
  };
  const intents = useRef(intent);
  intents.current = intent;
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const actions: { [K in MediaSessionAction]?: MediaSessionActionHandler } = {
      play: () => intents.current("PLAY"),
      pause: () => intents.current("PAUSE"),
      seekbackward: (details) =>
        intents.current(
          "SEEK",
          Math.max(
            0,
            (engine.current?.getPosition() ?? 0) - (details.seekOffset ?? 10),
          ),
        ),
      seekforward: (details) =>
        intents.current(
          "SEEK",
          Math.min(
            engine.current?.getDuration() ?? 0,
            (engine.current?.getPosition() ?? 0) + (details.seekOffset ?? 10),
          ),
        ),
      seekto: (details) => intents.current("SEEK", details.seekTime ?? 0),
    };
    for (const [action, handler] of Object.entries(actions))
      try {
        navigator.mediaSession.setActionHandler(
          action as MediaSessionAction,
          handler!,
        );
      } catch {
        /* Browser does not implement this action. */
      }
    return () => {
      for (const action of Object.keys(actions))
        try {
          navigator.mediaSession.setActionHandler(
            action as MediaSessionAction,
            null,
          );
        } catch {
          /* Capability unavailable. */
        }
    };
  }, []);
  const fullscreen = () => {
    if (!document.fullscreenElement)
      void shell.current?.requestFullscreen().catch(setError);
    else void document.exitFullscreen().catch(setError);
  };
  const chooseSubtitle = (value: string) => {
    if (value) lastSubtitle.current = value;
    subtitleLanguagePreference.current = value.startsWith("engine:")
      ? (tracks.find((track) => track.id === value.slice(7))?.language ?? "")
      : "";
    setSubtitle(value);
  };
  const toggleSub = () =>
    chooseSubtitle(
      subtitle
        ? ""
        : lastSubtitle.current ||
            media.subtitles?.[0]?.id ||
            (tracks.find((track) => track.kind === "subtitle")
              ? `engine:${tracks.find((track) => track.kind === "subtitle")!.id}`
              : ""),
    );
  const keyboard = (e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (
      ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(tag) ||
      (e.target as HTMLElement).closest('[role="slider"],[role="menu"]')
    )
      return;
    const k = e.key.toLowerCase();
    if (
      [" ", "k", "j", "l", "arrowleft", "arrowright", "m", "f", "c"].includes(k)
    )
      e.preventDefault();
    if (k === " " || k === "k") intent(transportPlaying ? "PAUSE" : "PLAY");
    if (k === "j" || k === "arrowleft")
      intent("SEEK", Math.max(0, position - (k === "j" ? 10 : 5)));
    if (k === "l" || k === "arrowright")
      intent("SEEK", Math.min(duration, position + (k === "l" ? 10 : 5)));
    if (k === "m") setMuted(!muted);
    if (k === "f" && document.fullscreenEnabled) fullscreen();
    if (k === "c") toggleSub();
  };
  const cueText = subtitle.startsWith("engine:")
    ? engineText
    : textCues
        .filter(
          (c) => position - offset >= c.start && position - offset < c.end,
        )
        .map((c) => c.text)
        .join("\n");
  const sprite = media.sprite,
    thumbIndex = sprite
      ? Math.floor((preview ?? position) / (sprite.interval ?? 10))
      : 0,
    columns = sprite?.columns ?? 10;
  return (
    <div
      ref={shell}
      className={classes(`${styles.shell} player ${cinema ? "cinema" : ""}`)}
      tabIndex={0}
      onKeyDown={keyboard}
      aria-label={t("player.label")}
    >
      <div
        className={classes("surface")}
        onPointerUp={(event) => {
          if (event.pointerType !== "touch") return;
          const now = performance.now(),
            x = event.clientX;
          if (
            now - lastTap.current.time < 350 &&
            Math.abs(x - lastTap.current.x) < 50
          ) {
            const rect = event.currentTarget.getBoundingClientRect();
            intent(
              "SEEK",
              Math.max(
                0,
                Math.min(
                  duration,
                  position + (x < rect.left + rect.width / 2 ? -10 : 10),
                ),
              ),
            );
            lastTap.current.time = 0;
          } else lastTap.current = { time: now, x };
        }}
        onDoubleClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          intent(
            "SEEK",
            Math.max(
              0,
              Math.min(
                duration,
                position + (e.clientX < rect.left + rect.width / 2 ? -10 : 10),
              ),
            ),
          );
        }}
      >
        <video
          ref={v}
          playsInline
          preload="auto"
          crossOrigin={
            descriptor.delivery === "direct" ? "anonymous" : undefined
          }
          aria-label={media.title}
        />
        {cueText && (
          <div
            className={classes(
              `subtitles ${background ? "subtitleBackground" : ""}`,
            )}
            style={{ fontSize: `${size}%` }}
          >
            {cueText}
          </div>
        )}
      </div>
      <Notice error={error} />
      <details>
        <summary>{t("player.diagnostics")}</summary>
        <dl>
          <dt>{t("source.label")}</dt>
          <dd>
            {label("source", descriptor.kind)} ·{" "}
            {label("source", descriptor.delivery)}
          </dd>
          <dt>{t("player.readiness")}</dt>
          <dd>{v.current?.readyState ?? 0}</dd>
          <dt>{t("player.availableBuffer")}</dt>
          <dd>
            {t("player.bufferSeconds", {
              seconds: number(buffer, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              }),
            })}
          </dd>
          {Object.entries(diagnostics?.() ?? {}).map(([name, value]) => (
            <div key={name}>
              <dt>{label("player", name)}</dt>
              <dd>
                {typeof value === "boolean"
                  ? t(value ? "common.yes" : "common.no")
                  : name === "state"
                    ? label("room", String(value))
                    : typeof value === "number"
                      ? number(value)
                      : value}
              </dd>
            </div>
          ))}
        </dl>
      </details>
      <div className={classes("transport")}>
        <div className={classes("timeline")}>
          <Slider.Root
            data-testid="video-timeline"
            disabled={!canControl}
            min={0}
            max={Math.max(1, duration)}
            step={0.1}
            value={[preview ?? position]}
            onValueChange={(n) => setPreview(n[0])}
            onValueCommit={(n) => {
              if (!cancelledSeek.current) intent("SEEK", n[0]);
              setPreview(null);
            }}
            onPointerDownCapture={() => {
              cancelledSeek.current = false;
            }}
            onPointerCancelCapture={() => {
              cancelledSeek.current = true;
              setPreview(null);
            }}
          >
            <Slider.Track className={classes("sliderTrack")}>
              <Slider.Range className={classes("sliderRange")} />
            </Slider.Track>
            <Slider.Thumb
              className={classes("sliderThumb")}
              aria-label={t("player.position")}
            />
          </Slider.Root>
          {preview !== null && (
            <div className={classes("timelinePreview")}>
              {sprite && (
                <span
                  className={classes("thumbnail")}
                  style={{
                    backgroundImage: `url(${sprite.url})`,
                    backgroundPosition: `-${(thumbIndex % columns) * (sprite.width ?? 160)}px -${Math.floor(thumbIndex / columns) * (sprite.height ?? 90)}px`,
                  }}
                />
              )}
              {time(preview)}
            </div>
          )}
          <small>
            {t("player.buffer", {
              time: time(Math.min(duration, position + buffer)),
            })}
          </small>
        </div>
        <div className={classes("actions playerActions")}>
          <button
            disabled={!canControl}
            aria-label={transportPlaying ? t("player.pause") : t("player.play")}
            onClick={() => intent(transportPlaying ? "PAUSE" : "PLAY")}
          >
            {transportPlaying ? "Ⅱ" : "▶"}
          </button>
          <button
            disabled={!canControl}
            aria-label={t("player.back10")}
            onClick={() => intent("SEEK", Math.max(0, position - 10))}
          >
            {"−10"}
          </button>
          <button
            disabled={!canControl}
            aria-label={t("player.forward10")}
            onClick={() => intent("SEEK", Math.min(duration, position + 10))}
          >
            {"+10"}
          </button>
          <span className={classes("time")}>
            {time(position)}
            {" / "}
            {time(duration)}{" "}
            <small>
              {"−"}
              {time(duration - position)}
            </small>
          </span>
          <button
            aria-label={muted ? t("player.unmute") : t("player.mute")}
            onClick={() => setMuted(!muted)}
          >
            {muted ? t("player.muted") : t("player.sound")}
          </button>
          <label className={classes("volume")}>
            {t("player.volume")}
            <input
              type="range"
              min="0"
              max="1"
              step=".05"
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              onPointerUp={() =>
                void api("/account", "PATCH", {
                  preferences: { volume, muted },
                }).catch(setError)
              }
            />
          </label>
          <Settings.Root modal={false}>
            <Settings.Trigger asChild>
              <button>{t("player.settings")}</button>
            </Settings.Trigger>
            <Settings.Portal>
              <Settings.Content
                className={classes("menu playerSettings")}
                aria-describedby={undefined}
              >
                <Settings.Title asChild>
                  <div>{t("player.playback")}</div>
                </Settings.Title>
                <label>
                  {t("player.speed")}
                  <select
                    aria-label={t("player.speed")}
                    disabled={!canControl}
                    value={room ? (baseRate ?? 1) : rate}
                    onChange={(e) => intent("SET_RATE", Number(e.target.value))}
                  >
                    {PLAYBACK_RATES.map((r) => (
                      <option key={r} value={r}>
                        {number(r, { maximumFractionDigits: 2 })}
                        {"×"}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("player.quality")}
                  <select
                    aria-label={t("player.quality")}
                    value={quality}
                    onChange={(e) => {
                      setQuality(e.target.value);
                      const track = tracks.find(
                        (track) => track.id === e.target.value,
                      );
                      qualityPreference.current = track?.height
                        ? `${track.height}p`
                        : "auto";
                      engine.current?.selectTrack(e.target.value);
                    }}
                  >
                    <option value="auto">
                      {t(tracks.length ? "player.auto" : "player.onlyQuality")}
                    </option>
                    {tracks
                      .filter((t) => t.kind === "video")
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                  </select>
                </label>
                {tracks.filter((t) => t.kind === "audio").length > 1 && (
                  <label>
                    {t("player.audio")}
                    <select
                      aria-label={t("player.audioTrack")}
                      value={audio}
                      onChange={(event) => {
                        setAudio(event.target.value);
                        engine.current?.selectTrack(event.target.value);
                      }}
                    >
                      <option value="" disabled>
                        {t("player.chooseTrack")}
                      </option>
                      {tracks
                        .filter((t) => t.kind === "audio")
                        .map((track) => (
                          <option key={track.id} value={track.id}>
                            {track.label ||
                              t(
                                track.kind === "subtitle"
                                  ? "player.subtitles"
                                  : "player.audio",
                              )}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                <label>
                  {t("player.subtitles")}
                  <select
                    aria-label={t("player.subtitles")}
                    value={subtitle}
                    onChange={(e) => chooseSubtitle(e.target.value)}
                  >
                    <option value="">{t("player.off")}</option>
                    {media.subtitles?.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                    {tracks
                      .filter((t) => t.kind === "subtitle")
                      .map((track) => (
                        <option key={track.id} value={`engine:${track.id}`}>
                          {track.label ||
                            t(
                              track.kind === "subtitle"
                                ? "player.subtitles"
                                : "player.audio",
                            )}
                        </option>
                      ))}
                  </select>
                </label>
                {subtitle && (
                  <>
                    <label>
                      {t("player.offset")}
                      <input
                        type="number"
                        min="-5"
                        max="5"
                        step=".25"
                        value={offset}
                        onChange={(e) =>
                          setOffset(
                            Math.round(
                              Math.max(
                                -5,
                                Math.min(5, Number(e.target.value)),
                              ) * 4,
                            ) / 4,
                          )
                        }
                      />
                    </label>
                    <label>
                      {t("player.size")}
                      <input
                        type="range"
                        min="75"
                        max="200"
                        step="5"
                        value={size}
                        onChange={(e) => setSize(Number(e.target.value))}
                      />
                    </label>
                    <label className={classes("check")}>
                      <input
                        type="checkbox"
                        checked={background}
                        onChange={(e) => setBackground(e.target.checked)}
                      />
                      {t("player.subtitleBackground")}
                    </label>
                  </>
                )}
                {!!media.chapters?.length && (
                  <label>
                    {t("player.chapters")}
                    <select
                      aria-label={t("player.goChapter")}
                      defaultValue=""
                      disabled={!canControl}
                      onChange={(e) => intent("SEEK", Number(e.target.value))}
                    >
                      <option value="" disabled>
                        {t("player.goChapter")}
                      </option>
                      {media.chapters.map((c) => (
                        <option key={c.startSeconds} value={c.startSeconds}>
                          {c.title}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </Settings.Content>
            </Settings.Portal>
          </Settings.Root>
          <button onClick={() => setCinema(!cinema)}>
            {t("player.cinema")}
          </button>
          {document.fullscreenEnabled && (
            <button onClick={fullscreen}>{t("player.fullscreen")}</button>
          )}
          {document.pictureInPictureEnabled && (
            <button
              onClick={() => {
                const video = v.current!;
                void (
                  document.pictureInPictureElement
                    ? document.exitPictureInPicture()
                    : video.requestPictureInPicture()
                ).catch(setError);
              }}
            >
              {t("player.pip")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
