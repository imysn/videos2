import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const platform = process.argv[2] ?? `linux/${process.arch}`;
assert(["linux/amd64", "linux/arm64", "linux/x64"].includes(platform));
const arch = platform.endsWith("arm64") ? "arm64" : "amd64";
const target = `linux/${arch}`;
await mkdir(".local", { recursive: true, mode: 0o700 });
const privateDir = await mkdtemp(resolve(".local/deployment-"));
const project = `rave-check-${arch}-${Date.now()}`;
const image = `rave-private:${project}`;
const log = resolve(privateDir, "docker.log");
const report = {
  platform: target,
  commit: "",
  PASS_CONFIG: false,
  PASS_BUILD: false,
  PASS_RUNTIME: false,
  checks: [] as string[],
  failure: "",
};
const env = {
  ...process.env,
  PUBLIC_ORIGIN: "https://deployment.invalid",
  RAVE_HOST: "",
  RAVE_IMAGE_TAG: project,
  RAVE_SECRET_DIR: resolve(privateDir, "secrets"),
  RAVE_COMPOSE_ENV_FILE: resolve(privateDir, "compose.env"),
  DOCKER_DEFAULT_PLATFORM: target,
  COMPOSE_PROFILES: "",
  GOOGLE_CLIENT_ID: "",
  GOOGLE_CLIENT_SECRET_FILE: "",
  GOOGLE_PICKER_API_KEY: "",
  GOOGLE_CLOUD_PROJECT_NUMBER: "",
  BACKUP_RECIPIENT: "",
};
// Every command uses an isolated project and synthetic secrets. Never reuse production.
const exec = promisify(execFile);
async function command(binary: string, args: string[]) {
  try {
    const result = await exec(binary, args, {
      env,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
    });
    await appendFile(log, result.stdout + result.stderr, { mode: 0o600 });
    return result.stdout.trim();
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    await appendFile(log, (e.stdout ?? "") + (e.stderr ?? ""), { mode: 0o600 });
    const operation =
      args.find((arg) =>
        ["build", "create", "up", "run", "restart", "exec"].includes(arg),
      ) ?? args[0];
    throw new Error(`${binary} ${operation} failed; private log: ${log}`);
  }
}
const composeArgs = [
  "compose",
  "--project-name",
  project,
  "--env-file",
  env.RAVE_COMPOSE_ENV_FILE,
  "-f",
  "compose.yaml",
  "-f",
  "compose.tailscale.yaml",
];
const compose = (...args: string[]) =>
  command("docker", [...composeArgs, ...args]);
const appNode = (source: string) =>
  compose("exec", "-T", "app", "node", "--input-type=module", "-e", source);
const stateSource = `
  import { loadConfig } from './dist/apps/api/src/infrastructure/config.js';
  import { Database } from './dist/packages/db/src/index.js';
  import { readFile } from 'node:fs/promises';
  import { createHash } from 'node:crypto';
  const db = new Database(loadConfig().databaseUrl);
  try {
    const users = await db.query('SELECT * FROM users ORDER BY slot');
    const migrations = await db.query('SELECT * FROM schema_migrations ORDER BY version');
    const media = await db.query("SELECT * FROM media WHERE title='[TEST] deployment persistence'");
    const credentials = await readFile('/private/bootstrap-credentials.json');
    const files = await Promise.all(['/data', '/backups', '/private'].map(p=>readFile(p+'/deployment-proof','utf8')));
    console.log(createHash('sha256').update(JSON.stringify({users,migrations,media,credentials:credentials.toString(),files})).digest('hex'));
  } finally { await db.close(); }
`;
async function runtimeCheck() {
  const ids = (await compose("ps", "-q")).split(/\s+/).filter(Boolean);
  assert.equal(ids.length, 3, "Only DB, app and worker must exist; no Caddy");
  const states = JSON.parse(await command("docker", ["inspect", ...ids])) as {
    Config: { Labels: Record<string, string> };
    State: {
      Running: boolean;
      Restarting: boolean;
      Health?: { Status: string };
    };
    HostConfig: {
      PortBindings: Record<string, { HostIp: string; HostPort: string }[]>;
      Tmpfs: Record<string, string>;
    };
    RestartCount: number;
  }[];
  for (const container of states) {
    assert.equal(container.State.Running, true);
    assert.equal(container.State.Restarting, false);
    const service = container.Config.Labels["com.docker.compose.service"];
    if (service === "app" || service === "db")
      assert.equal(container.State.Health?.Status, "healthy");
    if (service === "worker") assert.equal(container.RestartCount, 0);
    if (service === "app") {
      assert.deepEqual(container.HostConfig.PortBindings["3000/tcp"], [
        { HostIp: "127.0.0.1", HostPort: "3000" },
      ]);
      assert.equal(
        container.HostConfig.Tmpfs["/tmp"],
        "size=268435456,mode=1777",
      );
    }
  }
  assert.equal(
    await appNode(
      `const r=await fetch('http://127.0.0.1:3000/health/ready'); console.log(r.status);`,
    ),
    "200",
  );
  const response = await fetch("http://127.0.0.1:3000/health/ready");
  assert.equal(
    response.status,
    200,
    "The published host loopback port must work",
  );
}
try {
  report.commit = await command("git", ["rev-parse", "HEAD"]);
  await command("pnpm", [
    "exec",
    "tsx",
    "scripts/compose-prepare.ts",
    "--production",
  ]);
  await compose("config", "--quiet");
  const config = JSON.parse(await compose("config", "--format", "json"));
  assert.equal(
    config.services.caddy,
    undefined,
    "Caddy must be inactive by default",
  );
  const allProfiles = JSON.parse(
    await compose("--profile", "*", "config", "--format", "json"),
  );
  assert.deepEqual(allProfiles.services.caddy.profiles, ["disabled"]);
  assert.equal(config.services.app.ports.length, 1);
  assert.equal(config.services.app.ports[0].host_ip, "127.0.0.1");
  for (const name of ["app", "worker"]) {
    assert.equal(config.services[name].environment.APP_ENV, "production");
    assert.equal(config.services[name].environment.COOKIE_SECURE, "true");
    assert.equal(
      config.services[name].environment.PUBLIC_ORIGIN,
      env.PUBLIC_ORIGIN,
    );
    assert.deepEqual(config.services[name].tmpfs, [
      "/tmp:size=268435456,mode=1777",
    ]);
  }
  report.PASS_CONFIG = true;
  console.log(`${target} PASS_CONFIG`);
  if (!process.argv.includes("--config-only")) {
    const secretArgs = process.env.CODEX_PROXY_CERT
      ? ["--secret", `id=proxy_ca,src=${process.env.CODEX_PROXY_CERT}`]
      : [];
    await command("docker", [
      "build",
      "--platform",
      target,
      ...secretArgs,
      "-f",
      "infra/Dockerfile",
      "-t",
      image,
      ".",
    ]);
    assert.equal(
      await command("docker", [
        "image",
        "inspect",
        "--format",
        "{{.Architecture}}",
        image,
      ]),
      arch,
    );
    report.PASS_BUILD = true;
    console.log(`${target} PASS_BUILD`);
    // GitHub runners can have UID 1001. Only synthetic files in this test's
    // unique directory are adjusted for the image's fixed node UID 1000.
    await command("docker", [
      "run",
      "--rm",
      "--platform",
      target,
      "--user",
      "0",
      "--mount",
      `type=bind,source=${env.RAVE_SECRET_DIR},target=/test-secrets`,
      image,
      "sh",
      "-c",
      "chown 1000:1000 /test-secrets/postgres_password /test-secrets/database_url /test-secrets/master_key",
    ]);
    // These execute the target architecture, including native dependencies.
    await command("docker", [
      "run",
      "--rm",
      "--platform",
      target,
      image,
      "node",
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict'; import argon2 from 'argon2'; import sharp from 'sharp';
    assert.equal(process.arch, '${arch === "amd64" ? "x64" : "arm64"}');
    assert(await argon2.verify(await argon2.hash('synthetic-native-check'), 'synthetic-native-check'));
    assert((await sharp({create:{width:2,height:2,channels:3,background:'#000'}}).png().toBuffer()).length>0);
  `,
    ]);
    for (const [binary, arg] of [
      ["ffmpeg", "-version"],
      ["ffprobe", "-version"],
      ["age", "--version"],
      ["psql", "--version"],
      ["pg_dump", "--version"],
      ["node", "--version"],
    ])
      await command("docker", [
        "run",
        "--rm",
        "--platform",
        target,
        image,
        binary,
        arg,
      ]);
    await command("docker", [
      "run",
      "--rm",
      "--platform",
      target,
      image,
      "ffmpeg",
      "-hide_banner",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=16x16:d=0.2",
      "-threads",
      "2",
      "-c:v",
      "libx264",
      "-f",
      "null",
      "-",
    ]);
    report.checks.push(
      "target architecture, argon2, sharp, Node, FFmpeg encode, ffprobe, age, PostgreSQL client",
    );
    // Negative control: the old Compose mounts must actually be rejected by Docker.
    let rejected = false;
    try {
      await command("docker", [
        "create",
        "--name",
        `${project}-invalid-tmpfs`,
        "--tmpfs",
        "/tmp:size=268435456",
        "--tmpfs",
        "mode=1777",
        image,
        "true",
      ]);
    } catch {
      rejected = true;
    }
    assert(rejected, "Docker must reject the old invalid mount path");
    report.checks.push("invalid tmpfs negative control rejected by Docker");
    await compose("create");
    await compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "180");
    await delay(10_000);
    await runtimeCheck();
    await appNode(`
    import assert from 'node:assert/strict';
    import { loadConfig } from './dist/apps/api/src/infrastructure/config.js';
    import { Database } from './dist/packages/db/src/index.js';
    import { writeFile, stat } from 'node:fs/promises';
    const db=new Database(loadConfig().databaseUrl);
    try {
      const users=await db.query('SELECT username,role,must_change_password FROM users ORDER BY slot');
      assert.deepEqual(users,[{username:'jason',role:'OWNER',must_change_password:true},{username:'pareja',role:'PARTNER',must_change_password:true}]);
      assert.equal((await stat('/private/bootstrap-credentials.json')).mode & 0o077,0);
      await db.query("INSERT INTO media(id,title,content_generation,created_by) SELECT gen_random_uuid(),'[TEST] deployment persistence',gen_random_uuid(),id FROM users WHERE role='OWNER'");
      for(const p of ['/data','/backups','/private']) await writeFile(p+'/deployment-proof','synthetic persistent data',{mode:0o600});
    } finally {await db.close();}
  `);
    const before = await appNode(stateSource);
    await compose(
      "exec",
      "-T",
      "app",
      "node",
      "dist/apps/api/src/bootstrap.js",
    );
    assert.equal(
      await appNode(stateSource),
      before,
      "Bootstrap and migrations must be idempotent",
    );
    await compose("restart", "app", "worker");
    await compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "180");
    await delay(10_000);
    await runtimeCheck();
    assert.equal(
      await appNode(stateSource),
      before,
      "Data and credentials must survive restarts",
    );
    await compose(
      "up",
      "-d",
      "--no-build",
      "--force-recreate",
      "--wait",
      "--wait-timeout",
      "180",
    );
    await delay(10_000);
    await runtimeCheck();
    assert.equal(
      await appNode(stateSource),
      before,
      "Data must survive recreating all containers",
    );
    report.checks.push(
      "DB/app healthy, worker running without restart, host and container ready HTTP 200, no Caddy, loopback binding, bootstrap/migration idempotency, restart and recreation persistence",
    );
    report.PASS_RUNTIME = true;
    console.log(`${target} PASS_RUNTIME`);
  }
} catch (error) {
  report.failure =
    error instanceof Error ? error.message : "Deployment verification failed";
  console.error(report.failure);
  process.exitCode = 1;
} finally {
  await compose("down").catch(() => {}); // Never delete volumes, even for this isolated test.
  await mkdir("artifacts/verification", { recursive: true });
  await writeFile(
    `artifacts/verification/deployment-${arch}.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(
    `Evidence: artifacts/verification/deployment-${arch}.json; private logs: ${log}`,
  );
}
