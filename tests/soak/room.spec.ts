import { test, expect } from "@playwright/test";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { fixtureIds, twoPlayers, videoState } from "../e2e/helpers";
async function apiRssMiB() {
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const cmd = await readFile(`/proc/${pid}/cmdline`, "utf8");
      if (!cmd.split("\0").includes("dist/apps/api/src/main.js")) continue;
      const status = await readFile(`/proc/${pid}/status`, "utf8"),
        match = status.match(/^VmRSS:\s+(\d+) kB/m);
      if (match) return Number(match[1]) / 1024;
    } catch {
      /* Process may have exited. */
    }
  }
  throw new Error("No se pudo medir RSS del proceso API");
}
test("SYNC-22 — 30 minutos reales con dos HTMLVideoElement", async ({
  browser,
}) => {
  const ids = await fixtureIds(),
    { a, b, ca, cb } = await twoPlayers(browser, ids.long, 0);
  const memory: { elapsedSeconds: number; rssMiB: number }[] = [];
  const samples: {
    elapsedMs: number;
    first: number;
    second: number;
    error: number;
    rawError: number;
    commonSampleTimeMs: number;
    pausedA: boolean;
    pausedB: boolean;
    readyA: number;
    readyB: number;
    window: string;
  }[] = [];
  try {
    await a.getByRole("button", { name: "Reproducir", exact: true }).click();
    await expect
      .poll(async () => (await videoState(a)).paused, { timeout: 10000 })
      .toBe(false);
    await expect
      .poll(async () => (await videoState(b)).paused, { timeout: 10000 })
      .toBe(false);
    const start = performance.now();
    memory.push({ elapsedSeconds: 0, rssMiB: await apiRssMiB() });
    while (performance.now() - start < 1800000) {
      const elapsedMs = performance.now() - start;
      const [first, second] = await Promise.all([videoState(a), videoState(b)]);
      const common = Math.max(first.measuredAt, second.measuredAt);
      const projected = (s: typeof first) =>
        s.time + (s.paused ? 0 : ((common - s.measuredAt) * s.rate) / 1000);
      samples.push({
        elapsedMs,
        first: first.time,
        second: second.time,
        error: Math.abs(projected(first) - projected(second)),
        rawError: Math.abs(first.time - second.time),
        commonSampleTimeMs: common,
        pausedA: first.paused,
        pausedB: second.paused,
        readyA: first.ready,
        readyB: second.ready,
        window: elapsedMs < 2000 ? "initial-settling" : "stable",
      });
      if (samples.length % 120 === 0) {
        memory.push({
          elapsedSeconds: elapsedMs / 1000,
          rssMiB: await apiRssMiB(),
        });
        await mkdir("artifacts/sync", { recursive: true });
        await writeFile(
          "artifacts/sync/soak-progress.json",
          JSON.stringify({
            elapsedSeconds: elapsedMs / 1000,
            samples: samples.length,
            last: samples.at(-1),
          }),
        );
        console.log(
          `Soak real: ${Math.floor(elapsedMs / 60000)} min, ${samples.length} muestras`,
        );
      }
      await a.waitForTimeout(500);
    }
    const stable = samples.filter((s) => s.window === "stable"),
      errors = stable.map((s) => s.error).sort((a, b) => a - b),
      quantile = (p: number) => errors[Math.floor((errors.length - 1) * p)],
      summary = {
        wallSeconds: (performance.now() - start) / 1000,
        samples: samples.length,
        stableSamples: stable.length,
        excludedWindows: [{ reason: "initial-settling", seconds: 2 }],
        p50: quantile(0.5),
        p95: quantile(0.95),
        max: errors.at(-1),
        unexpectedPauses: stable.filter((s) => s.pausedA || s.pausedB).length,
        playedFirst: samples.at(-1)!.first - samples[0].first,
        playedSecond: samples.at(-1)!.second - samples[0].second,
        physicalDevice: false,
        memory,
        rssMaxMiB: Math.max(...memory.map((s) => s.rssMiB)),
        rssStartMiB: memory[0].rssMiB,
        rssEndMiB: memory.at(-1)!.rssMiB,
      };
    await mkdir("artifacts/sync", { recursive: true });
    await writeFile(
      "artifacts/sync/soak-samples.json",
      JSON.stringify(samples),
    );
    await writeFile(
      "artifacts/sync/soak-summary.json",
      JSON.stringify(summary, null, 2),
    );
    expect(summary.rssMaxMiB).toBeLessThan(350);
    expect(summary.rssEndMiB - summary.rssStartMiB).toBeLessThan(50);
    expect(summary.wallSeconds).toBeGreaterThanOrEqual(1800);
    expect(summary.playedFirst).toBeGreaterThan(1795);
    expect(summary.playedSecond).toBeGreaterThan(1795);
    expect(summary.unexpectedPauses).toBe(0);
    expect(summary.p95).toBeLessThanOrEqual(0.25);
    expect(summary.max).toBeLessThanOrEqual(0.75);
    await a.getByRole("button", { name: "Cerrar sesión compartida" }).click();
    await a.getByRole("button", { name: "Confirmar", exact: true }).click();
  } finally {
    await ca.close();
    await cb.close();
  }
});
