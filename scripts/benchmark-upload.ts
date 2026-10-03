import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { request } from "node:http";
import { open, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import pg from "pg";
import { loadConfig } from "../apps/api/src/infrastructure/config.js";
import { createApp } from "../apps/api/src/server.js";
import {
  checksum,
  storagePath,
} from "../apps/api/src/modules/media/storage.js";

interface Measurements {
  fileWriteMs: number;
  fileWriteCalls: number;
  fileSyncMs: number;
  fileSyncCalls: number;
  databaseMs: number;
  databaseQueries: number;
}
interface Resources {
  cpuUserMs: number;
  cpuSystemMs: number;
  peakRssBytes: number;
  io: Record<string, number>;
  timings: Measurements;
}
interface Ready {
  url: string;
  origin: string;
  cookie: string;
  csrf: string;
}
const emptyMeasurements = (): Measurements => ({
  fileWriteMs: 0,
  fileWriteCalls: 0,
  fileSyncMs: 0,
  fileSyncCalls: 0,
  databaseMs: 0,
  databaseQueries: 0,
});
async function io() {
  return Object.fromEntries(
    (await readFile("/proc/self/io", "utf8"))
      .trim()
      .split("\n")
      .map((line) => {
        const [key, value] = line.split(":");
        return [key, Number(value)];
      }),
  );
}
async function server() {
  const cfg = loadConfig();
  if (
    cfg.APP_ENV !== "test" ||
    !/^\/rave_(test|validation)(_[a-z0-9_]+)?$/.test(
      new URL(cfg.databaseUrl).pathname,
    )
  )
    throw new Error("Benchmark requires an isolated synthetic test database");
  const a = await createApp(cfg, { logger: false, roomLock: false });
  const credentials = JSON.parse(
    await readFile(
      resolve(dirname(process.env.RAVE_CONFIG_FILE!), "credentials.json"),
      "utf8",
    ),
  ) as Record<string, string>;
  const session = await a.auth.login(
    "jason",
    credentials.jason,
    "Upload benchmark",
  );
  let timings = emptyMeasurements();
  const probe = await open(
    resolve(cfg.DATA_ROOT, `benchmark-${randomUUID()}`),
    "wx",
  );
  const prototype = Object.getPrototypeOf(probe) as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  for (const name of ["write", "writev", "sync"] as const) {
    const original = prototype[name]!;
    Object.defineProperty(prototype, name, {
      value: async function (this: unknown, ...args: unknown[]) {
        const start = performance.now();
        try {
          return await Reflect.apply(original, this, args);
        } finally {
          if (name === "sync") {
            timings.fileSyncMs += performance.now() - start;
            timings.fileSyncCalls++;
          } else {
            timings.fileWriteMs += performance.now() - start;
            timings.fileWriteCalls++;
          }
        }
      },
    });
  }
  const originalQuery = pg.Client.prototype.query;
  Object.defineProperty(pg.Client.prototype, "query", {
    value: async function (this: pg.Client, ...args: unknown[]) {
      const start = performance.now();
      try {
        return await Reflect.apply(originalQuery, this, args);
      } finally {
        timings.databaseMs += performance.now() - start;
        timings.databaseQueries++;
      }
    },
  });
  await probe.close();
  let startCpu = process.cpuUsage(),
    startIo = await io(),
    peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 20);
  await a.app.listen({ host: "127.0.0.1", port: 0 });
  process.send?.({
    type: "ready",
    data: {
      url: a.app.listeningOrigin,
      origin: cfg.origin,
      cookie: `${cfg.cookieName}=${session.raw}`,
      csrf: session.identity.csrf,
    },
  });
  process.on("message", (raw) => {
    const message = raw as { id: string; operation: string; mediaId?: string };
    void (async () => {
      let data: unknown;
      if (message.operation === "reset") {
        timings = emptyMeasurements();
        startCpu = process.cpuUsage();
        startIo = await io();
        peakRss = process.memoryUsage().rss;
      } else if (message.operation === "metrics") {
        const cpu = process.cpuUsage(startCpu),
          currentIo = await io();
        data = {
          cpuUserMs: cpu.user / 1000,
          cpuSystemMs: cpu.system / 1000,
          peakRssBytes: peakRss,
          io: Object.fromEntries(
            Object.entries(currentIo).map(([key, value]) => [
              key,
              value - (startIo[key] ?? 0),
            ]),
          ),
          timings,
        };
      } else if (message.operation === "original") {
        const [row] = await a.db.query<{
          storage_key: string;
          checksum: string;
        }>(
          "SELECT storage_key,checksum FROM assets WHERE media_id=$1 AND kind='original'",
          [message.mediaId],
        );
        data = {
          checksum: row?.checksum,
          actualChecksum: row
            ? await checksum(storagePath(cfg.DATA_ROOT, row.storage_key))
            : null,
        };
      } else if (message.operation === "cleanup") {
        const [media] = await a.db.query<{ title: string }>(
          "SELECT title FROM media WHERE id=$1",
          [message.mediaId],
        );
        if (!media?.title.startsWith("[BENCH]"))
          throw new Error("Refusing to clean unrelated data");
        const uploads = await a.db.query<{ temporary_key: string }>(
          "SELECT temporary_key FROM uploads WHERE media_id=$1",
          [message.mediaId],
        );
        for (const row of uploads)
          await rm(storagePath(cfg.DATA_ROOT, row.temporary_key), {
            force: true,
          });
        await a.db.transaction(async (c) => {
          for (const table of ["jobs", "uploads", "assets"])
            await c.query(`DELETE FROM ${table} WHERE media_id=$1`, [
              message.mediaId,
            ]);
          await c.query("DELETE FROM media WHERE id=$1", [message.mediaId]);
        });
        await rm(resolve(cfg.DATA_ROOT, "originals", message.mediaId!), {
          recursive: true,
          force: true,
        });
      } else if (message.operation === "stop") {
        clearInterval(sampler);
        await a.app.close();
        process.send?.({ id: message.id });
        process.disconnect();
        return;
      }
      process.send?.({ id: message.id, data });
    })().catch((error: Error) =>
      process.send?.({ id: message.id, error: error.message }),
    );
  });
}
function option(name: string, fallback: number) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  const value = arg ? Number(arg.split("=")[1]) : fallback;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`Invalid ${name}`);
  return value;
}
async function benchmark() {
  const bytes = option("bytes", 256 * 1024 ** 2),
    repeats = option("repeats", 3),
    latencyMs = option("latency-ms", 0);
  const chunkSizes = (
    process.argv.find((a) => a.startsWith("--chunks="))?.split("=")[1] ??
    "1048576,8388608"
  )
    .split(",")
    .map(Number);
  if (
    !bytes ||
    !repeats ||
    chunkSizes.some((n) => !Number.isSafeInteger(n) || n < 1 || n > 8388608)
  )
    throw new Error("Invalid benchmark sizes");
  const output =
    process.argv.find((a) => a.startsWith("--output="))?.split("=")[1] ??
    ".local/upload-work/benchmark.json";
  const child = fork(resolve("scripts/benchmark-upload.ts"), ["--server"], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const pending = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (error: Error) => void }
  >();
  const ready = await new Promise<Ready>((done, fail) => {
    child.once("error", fail);
    child.once("exit", () => fail(new Error("Benchmark server exited")));
    child.on("message", (raw) => {
      const message = raw as {
        type?: string;
        id: string;
        data: unknown;
        error?: string;
      };
      if (message.type === "ready") done(message.data as Ready);
      else {
        const task = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) task?.reject(new Error(message.error));
        else task?.resolve(message.data);
      }
    });
  });
  const call = (operation: string, mediaId?: string) =>
    new Promise<unknown>((done, fail) => {
      const id = randomUUID();
      pending.set(id, { resolve: done, reject: fail });
      child.send({ id, operation, mediaId });
    });
  const headers = {
    cookie: ready.cookie,
    origin: ready.origin,
    "x-csrf-token": ready.csrf,
  };
  const json = async (path: string, body: unknown = {}) => {
    const r = await fetch(ready.url + path, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify(body),
    });
    if (!r.ok)
      throw new Error(
        `Benchmark HTTP ${r.status}: ${((await r.json()) as { code: string }).code}`,
      );
    return r.json();
  };
  const results: unknown[] = [];
  try {
    for (const chunkBytes of chunkSizes)
      for (let repetition = 0; repetition < repeats; repetition++) {
        const buffer = Buffer.allocUnsafe(chunkBytes);
        for (let n = 0; n < buffer.length; n++) buffer[n] = n % 251;
        const digest = createHash("sha256");
        const upload = (await json("/api/v1/admin/uploads", {
          title: `[BENCH] ${randomUUID()}`,
          description: "",
          originalName: "synthetic.bin",
          expectedBytes: bytes,
        })) as { id: string; mediaId: string };
        try {
          await call("reset");
          const clientCpu = process.cpuUsage(),
            started = performance.now();
          let requests = 0,
            peakClientRss = process.memoryUsage().rss;
          for (let offset = 0; offset < bytes;) {
            const chunk = buffer.subarray(
              0,
              Math.min(buffer.length, bytes - offset),
            );
            digest.update(chunk);
            if (latencyMs)
              await new Promise((done) => setTimeout(done, latencyMs));
            const r = await fetch(
              `${ready.url}/api/v1/admin/uploads/${upload.id}`,
              {
                method: "PATCH",
                headers: {
                  ...headers,
                  "content-type": "application/octet-stream",
                  "upload-offset": String(offset),
                },
                body: chunk,
              },
            );
            if (r.status !== 204) throw new Error(`Chunk HTTP ${r.status}`);
            offset = Number(r.headers.get("upload-offset"));
            requests++;
            peakClientRss = Math.max(peakClientRss, process.memoryUsage().rss);
          }
          const transferMs = performance.now() - started;
          const completed = await json(
            `/api/v1/admin/uploads/${upload.id}/complete`,
          );
          const totalMs = performance.now() - started,
            cpu = process.cpuUsage(clientCpu);
          const resources = (await call("metrics")) as Resources;
          const original = (await call("original", upload.mediaId)) as {
            checksum: string;
            actualChecksum: string;
          };
          const expected = digest.digest("hex");
          if (
            original.checksum !== expected ||
            original.actualChecksum !== expected
          )
            throw new Error("Benchmark checksum mismatch");
          results.push({
            bytes,
            chunkBytes,
            repetition,
            requests,
            transferMs,
            totalMs,
            completionMs: totalMs - transferMs,
            decimalMBps: bytes / transferMs / 1000,
            checksumVerified: true,
            completed,
            server: resources,
            client: {
              cpuUserMs: cpu.user / 1000,
              cpuSystemMs: cpu.system / 1000,
              peakRssBytes: peakClientRss,
            },
          });
          console.log(
            JSON.stringify({
              bytes,
              chunkBytes,
              repetition,
              requests,
              decimalMBps: bytes / transferMs / 1000,
              totalMs,
              server: resources,
            }),
          );
        } finally {
          await call("cleanup", upload.mediaId);
        }
      }
    const upload = (await json("/api/v1/admin/uploads", {
      title: `[BENCH] interruption ${randomUUID()}`,
      description: "",
      originalName: "interrupted.bin",
      expectedBytes: 1048576,
    })) as { id: string; mediaId: string };
    let interruption: unknown;
    try {
      await new Promise<void>((done) => {
        const req = request(`${ready.url}/api/v1/admin/uploads/${upload.id}`, {
          method: "PATCH",
          headers: {
            ...headers,
            "content-type": "application/octet-stream",
            "upload-offset": "0",
            "content-length": "1048576",
          },
        });
        req.on("error", () => done());
        req.write(Buffer.alloc(131072, 17));
        setTimeout(() => req.destroy(), 100);
      });
      await new Promise((done) => setTimeout(done, 200));
      const head = await fetch(
        `${ready.url}/api/v1/admin/uploads/${upload.id}`,
        { method: "HEAD", headers },
      );
      if (Number(head.headers.get("upload-offset")) !== 0)
        throw new Error("Partial request was acknowledged");
      const buffer = Buffer.alloc(1048576, 17);
      const patched = await fetch(
        `${ready.url}/api/v1/admin/uploads/${upload.id}`,
        {
          method: "PATCH",
          headers: {
            ...headers,
            "content-type": "application/octet-stream",
            "upload-offset": "0",
          },
          body: buffer,
        },
      );
      if (patched.status !== 204) throw new Error("Resume failed");
      await json(`/api/v1/admin/uploads/${upload.id}/complete`);
      const original = (await call("original", upload.mediaId)) as {
        actualChecksum: string;
      };
      const correct =
        original.actualChecksum ===
        createHash("sha256").update(buffer).digest("hex");
      if (!correct) throw new Error("Interrupted checksum mismatch");
      interruption = {
        partialRequestAborted: true,
        confirmedOffsetAfterAbort: 0,
        resumedChecksumCorrect: correct,
      };
    } finally {
      await call("cleanup", upload.mediaId);
    }
    await mkdir(dirname(resolve(output)), { recursive: true });
    await writeFile(
      output,
      JSON.stringify(
        {
          environment:
            "Codex Linux loopback; server process and PostgreSQL real; synthetic data; no Tailscale or microSD measurement",
          bytes,
          repeats,
          latencyMs,
          results,
          interruption,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await call("stop");
  }
}
if (process.argv.includes("--server")) await server();
else await benchmark();
