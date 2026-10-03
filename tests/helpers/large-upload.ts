import { copyFile, open, stat } from "node:fs/promises";
import { resolve } from "node:path";

// A legal MP4 free atom produces real transferred bytes without committing a large fixture.
export async function largeUploadFixture(file: string, bytes = 34 * 1024 ** 2) {
  await copyFile(resolve(".local/fixtures/short.mp4"), file);
  const original = (await stat(file)).size;
  if (bytes <= original + 8 || bytes - original >= 2 ** 32)
    throw new Error("Invalid synthetic MP4 size");
  const header = Buffer.alloc(8);
  header.writeUInt32BE(bytes - original);
  header.write("free", 4);
  const handle = await open(file, "r+");
  try {
    await handle.write(header, 0, 8, original);
    await handle.truncate(bytes);
  } finally {
    await handle.close();
  }
  return file;
}
