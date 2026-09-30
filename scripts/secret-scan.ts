import { readFile, readdir, stat, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
const secrets: { label: string; value: string }[] = [];
for (const profile of ["", "test/", "validation/"]) {
  try {
    const cfg = JSON.parse(
      await readFile(`.local/${profile}config.json`, "utf8"),
    );
    for (const field of [
      "DATABASE_URL_FILE",
      "MASTER_KEY_FILE",
      "GOOGLE_CLIENT_SECRET_FILE",
    ]) {
      if (cfg[field])
        secrets.push({
          label: field,
          value: (await readFile(cfg[field], "utf8")).trim(),
        });
    }
    const names = [
      resolve(`.local/${profile}credentials.json`),
      resolve(
        dirname(cfg.BOOTSTRAP_CREDENTIALS_FILE ?? cfg.MASTER_KEY_FILE),
        "bootstrap-credentials.json",
      ),
    ];
    for (const file of names) {
      try {
        const credentials = JSON.parse(await readFile(file, "utf8"));
        for (const [name, value] of Object.entries(credentials))
          if (typeof value === "string" && value.length >= 12)
            secrets.push({ label: `credential:${name}`, value });
      } catch {
        /* This profile has no bootstrap credentials. */
      }
    }
  } catch {
    /* Optional profile unavailable. */
  }
}
const files = new Set(
  execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean),
);
async function add(root: string) {
  try {
    for (const entry of await readdir(root)) {
      const file = `${root}/${entry}`;
      if ((await stat(file)).isDirectory()) await add(file);
      else files.add(file);
    }
  } catch {
    /* No compiled bundle yet. */
  }
}
await add("dist/web");
const findings: { file: string; rule: string; line: number }[] = [];
for (const file of files) {
  if (file.endsWith(".png") || file.endsWith(".jpg")) continue;
  const body = await readFile(file, "utf8");
  for (const { label, value } of secrets) {
    const index = body.indexOf(value);
    if (index >= 0)
      findings.push({
        file,
        rule: label,
        line: body.slice(0, index).split("\n").length,
      });
  }
  if (/-----BEGIN (?:AGE|RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(body))
    findings.push({ file, rule: "private-key", line: 0 });
}
await mkdir("artifacts/security", { recursive: true });
await writeFile(
  "artifacts/security/secret-scan.json",
  JSON.stringify(
    {
      status: findings.length ? "FAIL" : "PASS",
      files: files.size,
      secretBindingsCompared: secrets.length,
      findings,
      scope:
        "Git candidates and compiled web bundle; no secret values in report",
    },
    null,
    2,
  ),
);
console.log(
  `Secret scan: ${findings.length ? "FAIL" : "PASS"}; ${files.size} archivos; ${findings.length} hallazgos (solo ruta/regla/línea).`,
);
if (findings.length) process.exitCode = 1;
