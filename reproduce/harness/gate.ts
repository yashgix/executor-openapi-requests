// Regression gate for the offline sweep: run the same classification as sweep.ts, compare verdicts
// against a baseline, and always assert the two built-in fixture specs.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyApp } from "./sweep.ts";
import { checkFixtures } from "./gate-fixtures.ts";

type RequestBytes = { method: string; url: string; body?: string };
type Baseline = { apps: Record<string, Record<string, string>>; requests?: Record<string, RequestBytes> };

const args = process.argv.slice(2);
let update = false;
let idsArg: string[] | undefined;
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--update") {
    update = true;
  } else if (arg === "--ids") {
    idsArg = args[++i]?.split(",").filter(Boolean) ?? [];
  } else if (arg.startsWith("--ids=")) {
    idsArg = arg.slice("--ids=".length).split(",").filter(Boolean);
  } else {
    positional.push(arg);
  }
}

const [configDir = "", specDir = "", baselinePath = ""] = positional;
if (!configDir || !specDir || !baselinePath) {
  console.error("usage: node harness/gate.ts CONFIG_DIR SPEC_DIR BASELINE.json [--update] [--ids a,b,c]");
  process.exit(2);
}

const configs: Record<string, any> = JSON.parse(readFileSync(join(configDir, "configs.json"), "utf8"));
let baseline: Baseline = { apps: {} };
if (existsSync(baselinePath)) baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;

const RANK: Record<string, number> = {
  match: 0,
  encoding: 1,
  unsure: 2,
  "no-valid-input": 3,
  "run-failure": 4,
  "not-exposed": 5,
  "encode-failure": 6,
  wrong: 7,
  missing: 8,
};

const opKey = (row: any) => `${row.method} ${row.path} ${row.op}`;
const requestKey = (app: string, key: string) => `${app}::${key}`;
const parseRequestKey = (key: string) => {
  const sep = key.indexOf("::");
  return sep < 0 ? ["", key] as const : [key.slice(0, sep), key.slice(sep + 2)] as const;
};
const sentBytes = (row: any): RequestBytes | undefined => {
  const sent = row.sent;
  if (sent === undefined || typeof sent !== "object") return undefined;
  return {
    method: String(sent.method),
    url: String(sent.url),
    // Multipart boundaries are random per request, so they are replaced before comparing.
    ...(sent.body === undefined ? {} : { body: String(sent.body).replace(/formdata-undici-\d+/g, "formdata-undici-BOUNDARY") }),
  };
};
const bytesFor = (rows: any[], key: string) => {
  const candidates = rows.filter((row) => row.stage === "op" && row.sent !== undefined && opKey(row) === key);
  if (candidates.length === 0) return undefined;
  return sentBytes(candidates.find((row) => row.result === "wrong") ?? candidates[0]);
};
const chooseByteChecks = (apps: Baseline["apps"]) => {
  const byApp = new Map<string, string[]>();
  for (const id of Object.keys(apps).sort()) {
    const keys = Object.entries(apps[id] ?? {})
      .filter(([, verdict]) => verdict === "wrong")
      .map(([key]) => requestKey(id, key));
    if (keys.length > 0) byApp.set(id, keys);
  }
  const chosen: string[] = [];
  // Round-robin across apps so byte checks sample more of the corpus than one app's wrong operations.
  while (chosen.length < 10) {
    let added = false;
    for (const keys of byApp.values()) {
      const key = keys.shift();
      if (key === undefined) continue;
      chosen.push(key);
      added = true;
      if (chosen.length === 10) break;
    }
    if (!added) break;
  }
  return chosen;
};
const worst = (results: string[]) =>
  results.reduce((a, b) => (RANK[b]! >= RANK[a]! ? b : a), results[0] ?? "missing");
const verdicts = (rows: any[]) => {
  const grouped: Record<string, string[]> = {};
  for (const row of rows) {
    if (row.stage !== "op") continue;
    (grouped[opKey(row)] ??= []).push(row.result);
  }
  return Object.fromEntries(Object.entries(grouped).map(([key, results]) => [key, worst(results)]));
};

const isWorse = (previous: string, next: string) => RANK[next]! > RANK[previous]!;
const isBetter = (previous: string, next: string) => RANK[next]! < RANK[previous]!;

const ids = [...new Set(idsArg ?? Object.keys(baseline.apps).sort())];
const fixturesOk = await checkFixtures();

const started = Date.now();
const current: Baseline["apps"] = {};
const currentRows: Record<string, Record<string, any>[]> = {};
let operations = 0;
for (const id of ids) {
  const rows = await classifyApp(configs, configDir, specDir, id);
  current[id] = verdicts(rows);
  currentRows[id] = rows;
  operations += Object.keys(current[id]).length;
}
const seconds = (Date.now() - started) / 1000;

let worse = 0;
let better = 0;
let byteMismatches = 0;
for (const id of ids) {
  const before = baseline.apps[id] ?? {};
  const after = current[id] ?? {};
  // Union of keys: an operation that vanished or appeared is a change the baseline must record on purpose.
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const previous = before[key];
    const next = after[key] ?? "missing";
    if (previous === undefined) {
      worse += 1;
      console.log(`NEW ${id} ${key}: ${next}`);
    } else if (isWorse(previous, next)) {
      worse += 1;
      console.log(`WORSE ${id} ${key}: ${previous} -> ${next}`);
    } else if (isBetter(previous, next)) {
      better += 1;
      console.log(`better ${id} ${key}: ${previous} -> ${next}`);
    }
  }
}

if (!update) {
  for (const key of Object.keys(baseline.requests ?? {}).sort()) {
    const expected = baseline.requests?.[key];
    if (expected === undefined) continue;
    const [app, op] = parseRequestKey(key);
    const actual = bytesFor(currentRows[app] ?? [], op);
    if (actual === undefined) {
      byteMismatches += 1;
      console.log(`BYTES ${key}: missing current request (expected ${JSON.stringify(expected)})`);
    } else if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      byteMismatches += 1;
      console.log(`BYTES ${key}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
    }
  }
}

if (update) {
  const selected =
    baseline.requests === undefined ? chooseByteChecks(baseline.apps) : Object.keys(baseline.requests);
  const nextRequests: Record<string, RequestBytes> = { ...(baseline.requests ?? {}) };
  let stored = 0;
  for (const key of selected) {
    const [app, op] = parseRequestKey(key);
    const bytes = bytesFor(currentRows[app] ?? [], op);
    if (bytes === undefined) {
      console.log(`byte check skipped: no request captured for ${key}`);
      continue;
    }
    nextRequests[key] = bytes;
    stored += 1;
  }
  const next: Baseline = { apps: { ...baseline.apps, ...current } };
  if (stored > 0) next.requests = nextRequests;
  else if (baseline.requests !== undefined) next.requests = nextRequests;
  writeFileSync(baselinePath, JSON.stringify(next, null, 2) + "\n");
  console.log(`baseline updated: ${baselinePath} (${stored} byte checks recorded)`);
}

console.log(`apps=${ids.length} operations=${operations} worse=${worse} better=${better} bytes=${byteMismatches} seconds=${seconds.toFixed(1)}`);
if (!fixturesOk) console.error("fixtures failed");
if (worse > 0) console.error(`${worse} operation(s) got worse`);
if (byteMismatches > 0) console.error(`${byteMismatches} byte check(s) differ`);
if (!fixturesOk || worse > 0 || byteMismatches > 0) process.exit(1);
