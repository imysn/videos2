import { spawn } from "node:child_process";
import { mkdir, stat, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assert, AppError } from "../../../api/src/infrastructure/errors.js";
export interface Probe {
  format: { duration: string; format_name: string };
  streams: {
    codec_type: string;
    codec_name: string;
    width?: number;
    height?: number;
    index: number;
    tags?: Record<string, string>;
  }[];
  chapters?: { start_time: string; tags?: { title?: string } }[];
}
export async function run(
  binary: string,
  args: string[],
  signal?: AbortSignal,
  onProgress?: (seconds: number) => void,
): Promise<string> {
  return new Promise((done, fail) => {
    const p = spawn(binary, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
      killSignal: "SIGTERM",
    });
    let out = "",
      error = "",
      kill: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      kill = setTimeout(() => p.kill("SIGKILL"), 3000);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    p.stdout.on("data", (v) => {
      if (out.length < 2097152) out += v.toString();
      if (onProgress)
        for (const line of v.toString().split("\n"))
          if (line.startsWith("out_time_us=")) {
            const seconds = Number(line.split("=")[1]) / 1e6;
            if (Number.isFinite(seconds) && seconds >= 0) onProgress(seconds);
          }
    });
    p.stderr.on("data", (v) => {
      if (error.length < 16384) error += v.toString();
    });
    p.once("error", (e) => {
      signal?.removeEventListener("abort", cancel);
      if (kill) clearTimeout(kill);
      fail(e);
    });
    p.once("exit", (code) => {
      signal?.removeEventListener("abort", cancel);
      if (kill) clearTimeout(kill);
      if (code === 0) done(out);
      else
        fail(
          new AppError(
            /No space left/i.test(error)
              ? "INSUFFICIENT_STORAGE"
              : signal?.aborted
                ? "JOB_CANCELLED"
                : "MEDIA_CORRUPT",
            400,
          ),
        );
    });
  });
}
export async function probe(
  file: string,
  signal?: AbortSignal,
): Promise<Probe> {
  const json = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-format_whitelist",
      "mov,matroska,webm,avi,mpegts,mpeg,ogg,mp3,flac,wav",
      "-show_format",
      "-show_streams",
      "-show_chapters",
      "-of",
      "json",
      file,
    ],
    signal,
  );
  const p = JSON.parse(json) as Probe;
  const d = Number(p.format?.duration);
  assert(
    Number.isFinite(d) &&
      d > 0 &&
      d <= 24 * 3600 &&
      p.streams.some(
        (s) =>
          s.codec_type === "video" &&
          (s.width ?? 0) <= 8192 &&
          (s.height ?? 0) <= 8192,
      ),
    "MEDIA_CORRUPT",
  );
  return p;
}
export async function prepareVideo(
  file: string,
  out: string,
  threads: number,
  signal: AbortSignal,
  progress: (n: number) => void,
) {
  const info = await probe(file, signal);
  await mkdir(out, { recursive: true, mode: 0o700 });
  const duration = Number(info.format.duration);
  const video = info.streams.find((s) => s.codec_type === "video")!;
  const audios = info.streams.filter((s) => s.codec_type === "audio");
  const compatible =
    info.format.format_name.includes("mp4") &&
    video.codec_name === "h264" &&
    audios.every((s) => s.codec_name === "aac");
  const target = resolve(out, "compatible.mp4");
  const input = [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-protocol_whitelist",
    "file,pipe",
    "-format_whitelist",
    "mov,matroska,webm,avi,mpegts,mpeg,ogg",
    "-i",
    file,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
  ];
  await run(
    "ffmpeg",
    [
      ...input,
      ...(compatible
        ? ["-c", "copy"]
        : [
            "-c:v",
            "libx264",
            "-crf",
            "21",
            "-preset",
            "medium",
            "-threads",
            String(threads),
            "-vf",
            "scale=w=min(1920\\,iw):h=min(1080\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-ac",
            "2",
          ]),
      "-movflags",
      "+faststart",
      "-progress",
      "pipe:1",
      target,
    ],
    signal,
    (s) => progress(Math.min(0.8, (s / duration) * 0.8)),
  );
  const result = await probe(target, signal);
  assert(
    Math.abs(Number(result.format.duration) - duration) < 1,
    "INVALID_OUTPUT",
  );
  const poster = resolve(out, "poster.jpg");
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-ss",
      String(duration * 0.1),
      "-i",
      target,
      "-frames:v",
      "1",
      "-vf",
      "scale=640:-2",
      "-threads",
      String(threads),
      poster,
    ],
    signal,
  );
  const count = Math.min(360, Math.ceil(duration / 10)),
    columns = 10,
    rows = Math.ceil(count / columns),
    interval = duration / count;
  const sprite = resolve(out, "sprite.jpg");
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-i",
      target,
      "-vf",
      `fps=1/${interval},scale=160:90,tile=${columns}x${rows}`,
      "-frames:v",
      "1",
      "-threads",
      String(threads),
      sprite,
    ],
    signal,
  );
  const subtitles: { path: string; language: string; label: string }[] = [];
  for (const s of info.streams
    .filter(
      (s) =>
        s.codec_type === "subtitle" &&
        ["subrip", "webvtt", "mov_text", "text", "ass", "ssa"].includes(
          s.codec_name,
        ),
    )
    .slice(0, 10)) {
    const p = resolve(out, `subtitle-${s.index}.vtt`);
    await run(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        file,
        "-map",
        `0:${s.index}`,
        "-c:s",
        "webvtt",
        p,
      ],
      signal,
    );
    subtitles.push({
      path: p,
      language: s.tags?.language ?? "und",
      label: s.tags?.title ?? `Subtítulos ${s.index}`,
    });
  }
  return {
    duration,
    info: result,
    compatible: target,
    poster,
    sprite,
    columns,
    interval,
    count,
    subtitles,
  };
}
export async function prepareHls(
  file: string,
  out: string,
  threads: number,
  signal: AbortSignal,
  progress: (n: number) => void,
) {
  const info = await probe(file, signal);
  const video = info.streams.find((s) => s.codec_type === "video")!;
  const heights = [1080, 720, 480].filter((h) => h <= (video.height ?? 0));
  if (!heights.length) heights.push(video.height ?? 240);
  await mkdir(out, { recursive: true, mode: 0o700 });
  const master = ["#EXTM3U", "#EXT-X-VERSION:7"];
  const duration = Number(info.format.duration);
  for (let idx = 0; idx < heights.length; idx++) {
    const h = heights[idx],
      dir = resolve(out, `v${idx}`);
    await mkdir(dir, { recursive: true });
    await run(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        file,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "21",
        "-threads",
        String(threads),
        "-vf",
        `scale=-2:${h}`,
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-ac",
        "2",
        "-force_key_frames",
        "expr:gte(t,n_forced*4)",
        "-sc_threshold",
        "0",
        "-f",
        "hls",
        "-hls_time",
        "4",
        "-hls_playlist_type",
        "vod",
        "-hls_segment_type",
        "fmp4",
        "-hls_segment_filename",
        resolve(dir, "seg-%05d.m4s"),
        "-progress",
        "pipe:1",
        resolve(dir, "index.m3u8"),
      ],
      signal,
      (s) => progress((idx + s / duration) / heights.length),
    );
    const text = await readFile(resolve(dir, "index.m3u8"), "utf8");
    assert(text.includes("#EXT-X-ENDLIST"), "INVALID_OUTPUT");
    for (const filename of [
      ...text.split("\n").filter((l) => l && !l.startsWith("#")),
      "init.mp4",
    ])
      assert((await stat(resolve(dir, filename))).size > 0, "INVALID_OUTPUT");
    master.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${Math.max(300000, Math.round((h / 480) * 1000000))},RESOLUTION=${Math.round(((video.width ?? 640) * h) / (video.height ?? 480) / 2) * 2}x${h}`,
      `v${idx}/index.m3u8`,
    );
  }
  const files: Record<string, number> = {};
  for (const v of await readdir(out, { recursive: true })) {
    const s = await stat(resolve(out, String(v)));
    if (s.isFile()) files[String(v)] = s.size;
  }
  return { master: master.join("\n") + "\n", files };
}
