// For every operation of every sampled spec: generate an input from the tool's own schema, let
// Executor build the request offline, and compare it with the OpenAPI serialization rules.
// Usage: node harness/sweep.ts /out/configs /data/specs /out/sweep.jsonl [only-id]
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Schema } from "effect";
import { CORE_SCHEMA, load as loadYaml } from "js-yaml";
import { parse as parseYamlPackage } from "yaml";
import { patchOpenapi } from "../src/implementation/openapi-source.ts";
import { buildTools, capturingFetch, compile, runTool, type AppConfig, type Captured } from "./lib.ts";
import { generator, type Profile } from "./gen.ts";
import { compare } from "./oracle.ts";

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

const profiles: Record<string, Profile> = {
  plain: { text: "sample", branch: 0, optionalDepth: 3 },
  reserved: { text: "a b,c/d?e&f=g+h#i", branch: 0, optionalDepth: 3 },
  required: { text: "sample", branch: 0, optionalDepth: 0 },
};
const PLACEHOLDER = "placeholder-token";

// Executor's catch drops the thrown error; the instrumented copy hands it to this hook.
let lastCause: unknown;
const KEEP_MATCH_EVERY = Number(process.env.KEEP_MATCH_EVERY ?? 200);
let matches = 0;
(globalThis as any).__executorEncodeCause = (cause: unknown) => (lastCause = cause);

export function readDocument(id: string, configDir: string, specDir: string) {
  const inline = join(configDir, "documents", `${id}.json`);
  if (existsSync(inline)) return JSON.parse(readFileSync(inline, "utf8"));
  const text = readFileSync(join(specDir, `${id}.raw`), "utf8");
  if (text.trimStart().startsWith("{")) return JSON.parse(text);
  try {
    return JSON.parse(JSON.stringify(loadYaml(text, { schema: CORE_SCHEMA, maxAliases: 100 })));
  } catch {
    return JSON.parse(JSON.stringify(parseYamlPackage(text)));
  }
}

export function accounts(config: AppConfig) {
  const methods = Object.entries(config.methods ?? {}).map(([method, bindings]) => ({
    method,
    fields: Object.fromEntries(bindings.map(({ field }) => [field, PLACEHOLDER])),
  }));
  const oauth = (config.oauth ?? []).map((method) => ({ method, fields: { access_token: PLACEHOLDER } }));
  return [...methods, ...oauth, undefined];
}

/** Parameter names that carry the credential, which the reference does not produce. */
export const credentials = (op: any) => {
  const schemes = Object.values<any>(op.securitySchemes ?? {});
  const named = (place: string) =>
    schemes.filter((s) => s.type === "apiKey" && s.in === place).map((s) => String(s.name));
  const bearer = schemes.some((s) => s.type === "http" || s.type === "oauth2");
  return {
    query: named("query"),
    header: [...named("header"), ...(bearer ? ["authorization"] : [])].map((n) => n.toLowerCase()),
  };
};

const describeCause = (cause: unknown) =>
  cause instanceof Error ? `${cause.name}: ${cause.message}`.slice(0, 200) : String(cause).slice(0, 200);

// An operation the importer refused has no tool; a row keeps it in the baseline.
const skippedRow = (skipped: any) => ({
  stage: "op",
  op: skipped.operationId ?? skipped.name ?? "?",
  method: skipped.method ?? "?",
  path: skipped.path ?? "?",
  result: "not-exposed",
});

export async function classifyApp(
  configs: Record<string, any>,
  configDir: string,
  specDir: string,
  id: string,
): Promise<Record<string, any>[]> {
  const rows: Record<string, any>[] = [];
  const record = (row: object) => rows.push({ app: id, ...row });
  const config = configs[id];
  if (config === undefined) {
    record({ stage: "config", error: "missing config" });
    return rows;
  }
  if (config.error) {
    record({ stage: "config", error: config.error });
    return rows;
  }
  let compiled: Awaited<ReturnType<typeof compile>>;
  try {
    const document = patchOpenapi(readDocument(id, configDir, specDir), config.patches);
    compiled = await compile(document, config);
  } catch (error) {
    record({ stage: "compile", error: describeCause(error) });
    return rows;
  }
  record({ stage: "compiled", operations: compiled.operations.length, skipped: compiled.skipped.length });
  for (const skipped of compiled.skipped) record(skippedRow(skipped));
  const sink: Captured[] = [];
  const toolSets = [];
  for (const account of accounts(config))
    toolSets.push(
      await buildTools(compiled, { methods: config.methods, oauth: config.oauth ?? [], account, fetch: capturingFetch(sink) }),
    );
  for (const op of compiled.operations) {
    const tools = toolSets.find((set) => set[op.name] !== undefined);
    if (tools === undefined) {
      record({ stage: "op", op: op.name, method: op.method, path: op.path, result: "not-exposed" });
      continue;
    }
    const tool = tools[op.name]!;
    for (const [profileName, profile] of Object.entries(profiles)) {
      const row = { stage: "op", op: op.name, method: op.method, path: op.path, profile: profileName };
      const input = validInput(tool, op, compiled.definitions, profile);
      if (input === undefined) {
        record({ ...row, result: "no-valid-input" });
        continue;
      }
      lastCause = undefined;
      const result = await runTool(tools, op.name, input, sink);
      if (result.status === "sent" && result.request) {
        const finding = compare(op as any, input as any, result.request, credentials(op));
        // A sample of matches keeps its input too, so a second checker can measure its own false differences.
        const sampled = finding.kind === "match" && ++matches % KEEP_MATCH_EVERY === 0;
        const keep = finding.kind !== "match" || finding.exact === false || sampled;
        record({ ...row, result: finding.kind, notes: finding.notes, exact: finding.exact, ...(keep ? { input, sent: result.request } : {}) });
      } else {
        const encode = lastCause !== undefined;
        record({ ...row, result: encode ? "encode-failure" : "run-failure", cause: encode ? describeCause(lastCause) : result.failure?.slice(0, 300), input });
      }
    }
  }
  return rows;
}


/** An input Executor's own validator accepts, trying each body/oneOf branch in turn. */
function validInput(tool: any, op: any, definitions: Record<string, any>, profile: Profile) {
  const decode = Schema.decodeUnknownOption(tool.input);
  for (let branch = 0; branch < 4; branch++) {
    try {
      const candidate = generator(definitions, { ...profile, branch })(op.input);
      if (decode(candidate)._tag === "Some") return candidate;
    } catch {
      // A schema shape the generator does not model counts as no valid input.
    }
  }
  return undefined;
}

if (isMain) {
  const [configDir = "", specDir = "", outPath = "", onlyId] = process.argv.slice(2);
  const configs: Record<string, any> = JSON.parse(readFileSync(join(configDir, "configs.json"), "utf8"));

  async function sweepApp(id: string) {
    for (const row of await classifyApp(configs, configDir, specDir, id))
      appendFileSync(outPath, JSON.stringify(row) + "\n");
  }

  // Resumable: apps with a `done` row are skipped, and rows of an unfinished app are dropped.
  const previous = existsSync(outPath)
    ? readFileSync(outPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const done = new Set(previous.filter((row) => row.stage === "done").map((row) => row.app));
  writeFileSync(outPath, previous.filter((row) => done.has(row.app)).map((row) => JSON.stringify(row) + "\n").join(""));
  for (const id of onlyId ? [onlyId] : Object.keys(configs)) {
    if (done.has(id)) continue;
    const started = Date.now();
    await sweepApp(id);
    appendFileSync(outPath, JSON.stringify({ app: id, stage: "done" }) + "\n");
    console.log(`${id}: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
}
