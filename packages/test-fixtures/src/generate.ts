import { mkdir, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
const root = resolve(".local/fixtures");
await mkdir(root, { recursive: true, mode: 0o700 });
function run(args: string[]) {
  return new Promise<void>((ok, fail) => {
    const p = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args],
      { stdio: ["ignore", "ignore", "inherit"], shell: false },
    );
    p.on("error", fail);
    p.on("exit", (c) =>
      c === 0 ? ok() : fail(new Error("Fixture generation failed")),
    );
  });
}
async function generate(
  name: string,
  duration: number,
  width: number,
  height: number,
  fps: number,
) {
  const file = resolve(root, name);
  try {
    await access(file);
    return;
  } catch {
    /* Generate once. */
  }
  await run([
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${width}x${height}:rate=${fps}`,
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:sample_rate=48000",
    "-t",
    String(duration),
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-map",
    "2:a",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "34",
    "-threads",
    "2",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "32k",
    "-metadata:s:a:0",
    "language=spa",
    "-metadata:s:a:1",
    "language=eng",
    "-movflags",
    "+faststart",
    file,
  ]);
}
await Promise.all([
  generate("short.mp4", 120, 640, 360, 24),
  generate("long.mp4", 1925, 160, 90, 12),
  generate("adaptive.mp4", 20, 1280, 720, 24),
]);
await writeFile(
  resolve(root, "captions.srt"),
  "1\n00:00:01,000 --> 00:00:05,000\nVídeo sintético — solo pruebas\n\n2\n00:00:06,000 --> 00:00:09,000\n&lt;script&gt; nunca ejecutable\n",
);
console.log(
  "Fixtures sintéticos generados: 120 s, 1925 s y adaptativo 720p; dos tonos de audio.",
);
