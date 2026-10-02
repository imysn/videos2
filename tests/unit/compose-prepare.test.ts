import { afterAll, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

await mkdir(".local", { recursive: true, mode: 0o700 });
const root = await mkdtemp(resolve(".local/compose-prepare-test-"));
const exec = promisify(execFile);
const env = {
  ...process.env,
  PUBLIC_ORIGIN: "https://example.example-tailnet.ts.net",
  RAVE_SECRET_DIR: resolve(root, "secrets"),
  RAVE_COMPOSE_ENV_FILE: resolve(root, "compose.env"),
  RAVE_IMAGE_TAG: "pi-v1",
};
const run = (overrides = {}) =>
  exec(
    process.execPath,
    ["--import", "tsx", "scripts/compose-prepare.ts", "--production"],
    {
      env: { ...env, ...overrides },
    },
  );
afterAll(() => rm(root, { recursive: true, force: true }));
it("prepares private production files once and preserves existing configuration and secrets", async () => {
  await run();
  const paths = [
    env.RAVE_COMPOSE_ENV_FILE,
    ...["postgres_password", "database_url", "master_key"].map((n) =>
      resolve(env.RAVE_SECRET_DIR, n),
    ),
  ];
  const before = await Promise.all(paths.map((p) => readFile(p)));
  for (const path of paths) expect((await stat(path)).mode & 0o077).toBe(0);
  const config = before[0].toString();
  expect(config).toContain(`PUBLIC_ORIGIN=${env.PUBLIC_ORIGIN}`);
  expect(config).toContain("RAVE_IMAGE_TAG=pi-v1");
  expect(config).not.toContain("RAVE_HOST");
  await run({ PUBLIC_ORIGIN: "https://different.invalid" });
  expect(await Promise.all(paths.map((p) => readFile(p)))).toEqual(before);
});
it("rejects HTTP production before writing any files", async () => {
  const invalid = resolve(root, "invalid");
  await expect(
    run({
      PUBLIC_ORIGIN: "http://192.168.1.135:3000",
      RAVE_SECRET_DIR: invalid,
    }),
  ).rejects.toThrow();
  await expect(stat(invalid)).rejects.toThrow();
});
