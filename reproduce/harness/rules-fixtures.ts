// Offline check of the split: extra path parameters stay callable, `:name` placeholders are refused.
import { buildTools, capturingFetch, compile, runTool, type Captured } from "./lib.ts";

const ok = { "200": { description: "ok" } };
const path = (name: string) => ({ name, in: "path", required: true, schema: { type: "string" } });
const document = {
  openapi: "3.0.0",
  info: { title: "Fixture", version: "1" },
  paths: {
    "/ping": { get: { operationId: "ping", responses: ok } },
    "/items/{id}": { get: { operationId: "itemWithExtra", parameters: [path("id"), path("extra")], responses: ok } },
    "/jobs/:jobId": { get: { operationId: "colonPlaceholder", parameters: [path("jobId")], responses: ok } },
    "/files/{id}/*rest": { get: { operationId: "starPlaceholder", parameters: [path("id"), path("rest")], responses: ok } },
    "/search?limit={limit}": { get: { operationId: "searchWithQueryTemplate", parameters: [path("limit")], responses: ok } },
    "/note#view={id}": { get: { operationId: "fragmentTemplate", parameters: [path("id")], responses: ok } },
    "/files/{fileId}:copy": { post: { operationId: "customVerb", parameters: [path("fileId"), path("copy")], responses: ok } },
    "/orders/{id}:validate": { post: { operationId: "verbPrefix", parameters: [path("id"), path("v")], responses: ok } },
    "/tags/(\\d+)/active": { post: { operationId: "patternSegment", parameters: [path("optionId")], responses: ok } },
    "/find?limit={limit}": { get: { operationId: "undeclaredQueryPlaceholder", responses: ok } },
    "/items(archived)/{id}": { get: { operationId: "literalParentheses", parameters: [path("id"), path("extra")], responses: ok } },
    "/odata/getCounts(period='{period}')/{id}": { get: { operationId: "odataLike", parameters: [path("period"), path("id"), path("extra")], responses: ok } },
    "/zip/([0-9]+)/done": { get: { operationId: "bracketGroup", parameters: [path("zip")], responses: ok } },
    "/reports/{report_slug}": { get: { operationId: "misnamed", parameters: [path("report_id")], responses: ok } },
  },
};
const compiled: any = await compile(document as any, { baseUrl: "https://example.test" });
const sink: Captured[] = [];
const tools = await buildTools(compiled, { methods: undefined, oauth: [], account: undefined, fetch: capturingFetch(sink) });
const sent = async (name: string, input: unknown) => (await runTool(tools, name, input, sink)).request?.url;
console.log(JSON.stringify({
  exposed: compiled.operations.map((op: any) => ({ name: op.name, description: op.description.split("\n").slice(1) })),
  refused: compiled.skipped.map((s: any) => ({ path: s.path, code: s.code, reason: String(s.reason).slice(0, 140) })),
  itemWithExtra: await sent("items.itemWithExtra", { path: { id: "7", extra: "x" } }),
  customVerb: await sent("files.customVerb", { path: { fileId: "a", copy: "x" } }),
  undeclaredQueryPlaceholder: await sent("find.undeclaredQueryPlaceholder", {}),
  search: await sent("search.searchWithQueryTemplate", { path: { limit: "5" } }),
}, null, 1));
