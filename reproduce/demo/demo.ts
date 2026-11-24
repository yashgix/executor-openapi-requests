// The same tool calls and spec through one Executor tree, offline. Prints what each would send or report.
import { buildTools, capturingFetch, compile, runTool, type Captured } from "./lib.ts";

const ok = { 200: { description: "ok" } };
const list = { type: "array", items: { type: "string" } };
const document = (paths: Record<string, unknown>) => ({
  openapi: "3.1.0",
  info: { title: "demo", version: "1" },
  servers: [{ url: "https://api.example.com" }],
  paths,
});
const pathParam = (name: string) => ({ name, in: "path", required: true, schema: { type: "string" } });
const jsonBody = {
  required: true,
  content: { "application/json": { schema: { type: "object" } } },
};

const querySpec = document({
  "/items": {
    get: {
      operationId: "list",
      responses: ok,
      parameters: [
        { name: "tags", in: "query", style: "form", explode: false, schema: list },
        { name: "pipes", in: "query", style: "pipeDelimited", explode: false, schema: list },
        { name: "q", in: "query", schema: { type: "string" } },
        { name: "path", in: "query", allowReserved: true, schema: { type: "string" } },
      ],
    },
  },
});
const queryCases = [
  ["Comma-separated list", { tags: ["red", "blue"] }, "?tags=red,blue"],
  ["Pipe-delimited list", { pipes: ["a", "b"] }, "?pipes=a%7Cb"],
  ["Space in a value", { q: "two words" }, "?q=two%20words"],
  ["Reserved value", { path: "a/b:c" }, "?path=a/b:c"],
] as const;

const importSpec = document({
  "/users/{id}": { get: { operationId: "misnamed", responses: ok, parameters: [pathParam("user_id")] } },
  "/items/{id}": { get: { operationId: "extra", responses: ok, parameters: [pathParam("id"), pathParam("other")] } },
  "/broken/{id?}": { get: { operationId: "strayBrace", responses: ok } },
  "/report": { get: { operationId: "getWithBody", responses: ok, requestBody: jsonBody } },
  "/health": { get: { operationId: "control", responses: ok } },
});
const importCases = [
  ["Path placeholder with no matching parameter", "misnamed"],
  ["Declared parameter the path never uses", "extra"],
  ["Stray brace in the path", "strayBrace"],
  ["GET with a required body", "getWithBody"],
  ["Valid operation (control)", "control"],
] as const;

async function queries() {
  const compiled = await compile(querySpec);
  const sink: Captured[] = [];
  const tools = await buildTools(compiled, { methods: {}, oauth: [], account: undefined, fetch: capturingFetch(sink) });
  const rows = [];
  for (const [label, query, expected] of queryCases) {
    const result = await runTool(tools, compiled.operations[0]!.name, { query }, sink);
    rows.push({ label, expected, sent: result.request ? new URL(result.request.url).search : result.status });
  }
  return rows;
}

async function imports() {
  const compiled = await compile(importSpec);
  const named = (entry: { name?: unknown }, id: string) => String(entry.name ?? "").toLowerCase().includes(id.toLowerCase());
  return importCases.map(([label, id]) => {
    const skipped = (compiled.skipped as { name?: unknown; code?: unknown }[]).find((entry) => named(entry, id));
    return { label, outcome: skipped ? `named at import (${skipped.code})` : "exposed as a tool" };
  });
}

console.log(JSON.stringify({ queries: await queries(), imports: await imports() }));
