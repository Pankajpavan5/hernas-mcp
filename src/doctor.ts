import { existsSync, statSync, accessSync, constants } from "node:fs";
import { config } from "./config.ts";

type Check = { name: string; ok: boolean; detail: string; fix?: string };

const results: Check[] = [];
const add = (name: string, ok: boolean, detail: string, fix?: string) =>
  results.push({ name, ok, detail, fix });

// 1. Runtime. Node 22.6+ runs TypeScript directly and ships node:sqlite.
const [maj, min] = process.versions.node.split(".").map(Number);
add(
  "node",
  maj > 22 || (maj === 22 && min >= 6),
  `v${process.versions.node}`,
  "Install Node >= 22.6: it runs TypeScript directly and ships node:sqlite.",
);

// 2. Data directory must be writable, not just present.
let dataOk = false;
try {
  accessSync(config.dataDir, constants.W_OK);
  dataOk = true;
} catch {
  dataOk = false;
}
add("data dir", dataOk, config.dataDir, `mkdir -p ${config.dataDir} && chmod 700 ${config.dataDir}`);

// 3. The key file must exist and be private.
if (existsSync(config.keyPath)) {
  const mode = statSync(config.keyPath).mode & 0o777;
  add("key file", mode === 0o600, `${config.keyPath} mode ${mode.toString(8)}`, `chmod 600 ${config.keyPath}`);
} else {
  add("key file", false, `missing at ${config.keyPath}`, "Start the server once to generate it.");
}

// 4. Is the server actually answering?
let serverOk = false;
let detail = `nothing answering on ${config.host}:${config.port}`;
try {
  const res = await fetch(`http://${config.host}:${config.port}/healthz`, {
    signal: AbortSignal.timeout(2000),
  });
  if (res.ok) {
    const body = (await res.json()) as { ok?: boolean; version?: string };
    serverOk = body.ok === true;
    detail = `healthy, version ${body.version}`;
  } else {
    detail = `/healthz returned ${res.status}`;
  }
} catch {
  serverOk = false;
}
add(
  "server",
  serverOk,
  detail,
  `Start it with: npm start   (then open http://127.0.0.1:${config.port}/)`,
);

// 5. adb is informational in this build: the device layer is the outbound relay.
const adbPath = ["/data/data/com.termux/files/usr/bin/adb", "/usr/bin/adb"].find((p) => existsSync(p));
add(
  "adb",
  true,
  adbPath ? `present at ${adbPath} (not used by the relay transport)` : "not installed (not required: device control uses the outbound relay)",
);

const width = Math.max(...results.map((r) => r.name.length));
let failed = 0;
console.log("\n  hernas doctor\n");
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}`);
  if (!r.ok && r.fix) console.log(`        ${" ".repeat(width)}  fix: ${r.fix}`);
}
console.log(`\n  ${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed > 0 ? 1 : 0);
