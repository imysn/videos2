import type {
  PlaybackDescriptor,
  PlaybackTrack,
  PlayerCapabilities,
} from "../../../../packages/contracts/src/protocol";
export interface EngineAdapter {
  video: HTMLVideoElement;
  load: (d: PlaybackDescriptor) => Promise<void>;
  unload: () => Promise<void>;
  play: () => Promise<void>;
  pause: () => void;
  seek: (position: number) => void;
  getPosition: () => number;
  getDuration: () => number;
  getBuffered: () => number;
  setRate: (rate: number) => void;
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
  listTracks: () => PlaybackTrack[];
  selectTrack: (id: string) => void;
  getCapabilities: () => PlayerCapabilities;
  on: (event: string, listener: EventListener) => () => void;
  subtitleAt: (position: number) => string;
  destroy: () => Promise<void>;
}
interface NativeAudioTrack {
  id: string;
  label: string;
  language: string;
  enabled: boolean;
}
export class NativeFileEngine implements EngineAdapter {
  protected descriptor?: PlaybackDescriptor;
  constructor(public video: HTMLVideoElement) {}
  async load(d: PlaybackDescriptor) {
    this.descriptor = d;
    this.video.src = d.url;
    this.video.load();
  }
  async unload() {
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
  }
  play() {
    return this.video.play();
  }
  pause() {
    this.video.pause();
  }
  seek(p: number) {
    if (Number.isFinite(this.video.duration))
      this.video.currentTime = Math.min(Math.max(0, p), this.video.duration);
  }
  getPosition() {
    return this.video.currentTime;
  }
  getDuration() {
    return this.video.duration;
  }
  getBuffered() {
    const v = this.video;
    for (let i = 0; i < v.buffered.length; i++)
      if (
        v.buffered.start(i) <= v.currentTime + 0.05 &&
        v.buffered.end(i) >= v.currentTime
      )
        return v.buffered.end(i) - v.currentTime;
    return 0;
  }
  setRate(r: number) {
    this.video.playbackRate = r;
  }
  setVolume(v: number) {
    this.video.volume = v;
  }
  setMuted(v: boolean) {
    this.video.muted = v;
  }
  protected audioTracks() {
    return (
      this.video as HTMLVideoElement & {
        audioTracks?: ArrayLike<NativeAudioTrack>;
      }
    ).audioTracks;
  }
  listTracks(): PlaybackTrack[] {
    return Array.from(this.audioTracks() ?? []).map((track, index) => ({
      id: `audio:${index}`,
      kind: "audio",
      label: track.label || track.language || `Audio ${index + 1}`,
      language: track.language,
    }));
  }
  selectTrack(id: string) {
    if (id.startsWith("audio:"))
      Array.from(this.audioTracks() ?? []).forEach((track, index) => {
        track.enabled = id === `audio:${index}`;
      });
  }
  getCapabilities(): PlayerCapabilities {
    return {
      ...(this.descriptor?.capabilities ?? {
        seek: true,
        rate: true,
        qualitySelection: false,
        audioTrackSelection: false,
        subtitles: false,
        thumbnails: false,
        chapters: false,
      }),
      qualitySelection: false,
      audioTrackSelection: (this.audioTracks()?.length ?? 0) > 1,
    };
  }
  on(event: string, listener: EventListener) {
    this.video.addEventListener(event, listener);
    return () => this.video.removeEventListener(event, listener);
  }
  subtitleAt(_position: number) {
    return "";
  }
  destroy() {
    return this.unload();
  }
}
interface Variant {
  id: number;
  language: string;
  height: number;
  width: number;
  bandwidth: number;
  label?: string;
  active: boolean;
  audioId?: number;
  audioLabel?: string;
}
interface ShakaPlayer {
  attach: (v: HTMLVideoElement) => Promise<void>;
  load: (url: string) => Promise<void>;
  destroy: () => Promise<void>;
  unload: () => Promise<void>;
  configure: (v: unknown) => void;
  getVariantTracks: () => Variant[];
  getTextTracks: () => Variant[];
  selectVariantTrack: (v: Variant, clear: boolean) => void;
  selectTextTrack: (v: Variant) => void;
  setTextTrackVisibility: (v: boolean) => void;
  getNetworkingEngine: () => {
    registerRequestFilter: (
      f: (type: number, request: { uris: string[] }) => void,
    ) => void;
  };
  addEventListener: (name: string, f: (e: Event) => void) => void;
}
interface ShakaLibrary {
  Player: new () => ShakaPlayer;
  polyfill: { installAll: () => void };
}
interface EngineCue {
  startTime: number;
  endTime: number;
  payload: string;
  nestedCues?: EngineCue[];
}
export class AdaptiveEngine extends NativeFileEngine {
  private player?: ShakaPlayer;
  private disposed = false;
  private textVisible = false;
  private cues: EngineCue[] = [];
  private textDelay = 0;
  async load(d: PlaybackDescriptor) {
    this.descriptor = d;
    if (
      d.kind === "hls" &&
      this.video.canPlayType("application/vnd.apple.mpegurl") &&
      /Apple/.test(navigator.vendor)
    ) {
      await super.load(d);
      return;
    }
    const module = await import("shaka-player/dist/shaka-player.compiled.js");
    if (this.disposed) return;
    const shaka = module.default as unknown as ShakaLibrary;
    shaka.polyfill.installAll();
    const player = new shaka.Player();
    this.player = player;
    player.addEventListener("error", (event) => {
      const detail = (event as CustomEvent<{ severity: number }>).detail;
      if (detail?.severity === 2 && this.player === player && !this.disposed)
        this.video.dispatchEvent(new Event("error"));
    });
    await player.attach(this.video);
    if (this.disposed) return;
    const origins = new Set(d.approvedOrigins);
    player.getNetworkingEngine().registerRequestFilter((_type, request) => {
      for (const uri of request.uris) {
        const u = new URL(uri, location.origin);
        if (
          !origins.has(u.origin) ||
          (u.protocol !== "https:" && u.origin !== location.origin)
        )
          throw new Error("Origen multimedia no autorizado");
      }
    });
    player.configure({
      textDisplayFactory: () => ({
        configure: (config: { subtitleDelay: number }) => {
          // Shaka owns cue timing; local size/background are rendered by Player.
          this.textDelay = config.subtitleDelay;
        },
        setTextLanguage: (_language: string) => {
          // Track selection is authoritative; the overlay displays its cues.
        },
        append: (cues: EngineCue[]) => {
          this.cues.push(...cues);
          if (this.cues.length > 6000)
            this.cues.splice(0, this.cues.length - 6000);
        },
        remove: (start: number, end: number) => {
          this.cues = this.cues.filter(
            (cue) => !(cue.startTime >= start && cue.endTime <= end),
          );
          return true;
        },
        isTextVisible: () => this.textVisible,
        setTextVisibility: (visible: boolean) => {
          this.textVisible = visible;
        },
        destroy: async () => {
          this.cues = [];
        },
      }),
      streaming: { bufferingGoal: 12, rebufferingGoal: 2 },
      abr: { enabled: true },
    });
    await player.load(d.url);
  }
  listTracks(): PlaybackTrack[] {
    if (!this.player) return super.listTracks();
    const variants = this.player.getVariantTracks(),
      active = variants.find((track) => track.active),
      quality = new Set<number>(),
      audio = new Set<string>(),
      tracks: PlaybackTrack[] = [];
    for (const variant of variants) {
      if (
        (!active || variant.language === active.language) &&
        !quality.has(variant.height)
      ) {
        quality.add(variant.height);
        tracks.push({
          id: String(variant.id),
          kind: "video",
          label: `${variant.height}p`,
          height: variant.height,
          width: variant.width,
          bandwidth: variant.bandwidth,
        });
      }
      const audioKey = String(variant.audioId ?? variant.language);
      if (!audio.has(audioKey)) {
        audio.add(audioKey);
        tracks.push({
          id: `audio:${variant.id}`,
          kind: "audio",
          label: variant.audioLabel || variant.language || "Audio",
          language: variant.language,
        });
      }
    }
    for (const track of this.player.getTextTracks())
      tracks.push({
        id: `text:${track.id}`,
        kind: "subtitle",
        label: track.label || track.language || "Subtítulos",
        language: track.language,
      });
    return tracks;
  }
  selectTrack(id: string) {
    if (!this.player) {
      super.selectTrack(id);
      return;
    }
    if (id === "text:off") {
      this.player.setTextTrackVisibility(false);
      return;
    }
    if (id.startsWith("text:")) {
      const text = this.player
        .getTextTracks()
        .find((track) => String(track.id) === id.slice(5));
      if (text) {
        this.player.selectTextTrack(text);
        this.player.setTextTrackVisibility(true);
      }
      return;
    }
    if (id.startsWith("audio:")) {
      const selected = this.player
        .getVariantTracks()
        .find((track) => String(track.id) === id.slice(6));
      if (selected) {
        const active = this.player
          .getVariantTracks()
          .find((track) => track.active);
        const track =
          this.player
            .getVariantTracks()
            .find(
              (track) =>
                track.language === selected.language &&
                track.height === active?.height,
            ) ?? selected;
        this.player.selectVariantTrack(track, true);
      }
      return;
    }
    if (id === "auto") {
      this.player.configure({ abr: { enabled: true } });
      return;
    }
    const track = this.player
      .getVariantTracks()
      .find((track) => String(track.id) === id);
    if (track) {
      this.player.configure({ abr: { enabled: false } });
      this.player.selectVariantTrack(track, true);
    }
  }
  getCapabilities(): PlayerCapabilities {
    const base = super.getCapabilities(),
      tracks = this.listTracks();
    return {
      ...base,
      qualitySelection:
        tracks.filter((track) => track.kind === "video").length > 1,
      audioTrackSelection:
        tracks.filter((track) => track.kind === "audio").length > 1,
      subtitles:
        base.subtitles || tracks.some((track) => track.kind === "subtitle"),
    };
  }
  async unload() {
    this.cues = [];
    if (this.player) await this.player.unload();
    await super.unload();
  }
  async destroy() {
    this.disposed = true;
    if (this.player) {
      await this.player.destroy();
      this.player = undefined;
    }
    await super.unload();
  }
  subtitleAt(position: number) {
    if (!this.textVisible) return "";
    position -= this.textDelay;
    const payload = (cue: EngineCue): string =>
      [cue.payload, ...(cue.nestedCues ?? []).map(payload)].join("");
    return this.cues
      .filter((cue) => cue.startTime <= position && cue.endTime > position)
      .map(payload)
      .join("\n")
      .slice(0, 10000)
      .replace(/<[^>]*>/g, "");
  }
}
