import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { prepareVideo } from "../../apps/worker/src/media/process.js";
import { checksum } from "../../apps/api/src/modules/media/storage.js";
const mount = resolve(process.argv[2]),
  original = resolve(".local/fixtures/short.mp4");
const digest = await checksum(original);
let mounted = false;
try {
  // Called only inside unshare --user --map-root-user --mount. The tiny mount
  // is private to that child and cannot fill the workspace/shared filesystem.
  execFileSync("mount", [
    "-t",
    "tmpfs",
    "-o",
    "size=1m,nosuid,nodev",
    "tmpfs",
    mount,
  ]);
  mounted = true;
  const out = resolve(mount, "output");
  await mkdir(out);
  let code = "";
  try {
    await prepareVideo(
      original,
      out,
      2,
      new AbortController().signal,
      () => {},
    );
  } catch (error) {
    code = (error as NodeJS.ErrnoException).code ?? "";
  }
  if (code !== "ENOSPC" && code !== "INSUFFICIENT_STORAGE")
    throw new Error(
      "El volumen fixture no produjo un error de disco lleno real.",
    );
  await rm(out, { recursive: true, force: true });
  if ((await checksum(original)) !== digest)
    throw new Error("El original cambió.");
  console.log(
    JSON.stringify({
      status: "PASS",
      isolatedMount: true,
      capacityBytes: 1048576,
      actualError: code,
      originalIntact: true,
      temporaryOutputsRemoved: true,
    }),
  );
} finally {
  if (mounted) execFileSync("umount", [mount]);
}
