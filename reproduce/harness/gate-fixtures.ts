// Two built-in specs the gate always checks. They are deliberately not part of the baseline:
// (a) a path fragment that must be dropped from the HTTP path, and (b) a malformed path template
// that must never produce a callable tool sending a literal `{id?}`.
import { Schema } from "effect";
import { buildTools, capturingFetch, compile, runTool, type Captured } from "./lib.ts";

const describe = (error: unknown) => String(error).slice(0, 200);

type Compiled = Awaited<ReturnType<typeof compile>>;

const OK = { "200": { description: "ok" } };
const bodyOf = (required: boolean) => ({
  required,
  content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } },
});

// Every fixture spec also holds one ordinary operation: a spec with nothing callable left fails to compile at all.
const CONTROL = { "/ping": { get: { operationId: "ping", responses: { "200": { description: "ok" } } } } };

const compileSpec = (paths: object): Promise<Compiled> =>
  compile(
    { openapi: "3.0.0", info: { title: "Fixture", version: "1" }, paths: { ...CONTROL, ...paths } } as any,
    { baseUrl: "https://example.test" },
  );

const findOp = (compiled: Compiled, method: string, path?: string) =>
  compiled.operations.find(
    (candidate: any) =>
      String(candidate.method).toLowerCase() === method &&
      (path === undefined || candidate.path === path) &&
      candidate.path !== "/ping",
  );

const skippedEntry = (compiled: Compiled, method: string, path: string, name: string, code: string) =>
  compiled.skipped.find(
    (entry: any) =>
      String(entry.method).toLowerCase() === method.toLowerCase() &&
      entry.path === path &&
      entry.name === name &&
      entry.code === code,
  );

const hasTool = (tools: Awaited<ReturnType<typeof buildTools>>, name: string) => tools[name] !== undefined;

/** A refused operation must be reported structurally and absent from both compiled operations and built tools. */
async function refusedAtImport(
  label: string,
  compiled: Compiled,
  method: string,
  path: string,
  name: string,
  code: string,
): Promise<boolean> {
  const reported = skippedEntry(compiled, method, path, name, code) !== undefined;
  const compiledExposed = findOp(compiled, method, path) !== undefined;
  let toolExposed = false;
  let toolsBuilt = false;
  try {
    const tools = await buildTools(compiled, {
      methods: undefined,
      oauth: [],
      account: undefined,
      fetch: capturingFetch([]),
    });
    toolsBuilt = true;
    toolExposed = hasTool(tools, name);
  } catch (error) {
    console.log(`fixture ${label}: tool build failed: ${describe(error)}`);
  }
  console.log(`fixture ${label}: reported=${reported} compiledExposed=${compiledExposed} toolExposed=${toolExposed} toolsBuilt=${toolsBuilt}`);
  return reported && !compiledExposed && toolsBuilt && !toolExposed;
}

async function fragmentFixture(): Promise<boolean> {
  console.log("fixture fragment: POST /oauth2/token#refresh");
  const spec = {
    openapi: "3.0.0",
    info: { title: "Fixture fragment", version: "1" },
    paths: {
      "/oauth2/token#refresh": {
        post: {
          operationId: "postTokenRefresh",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
  let compiled: Awaited<ReturnType<typeof compile>>;
  try {
    compiled = await compile(spec as any, { baseUrl: "https://example.test" });
  } catch (error) {
    console.log(`fixture fragment: refused at compile: ${describe(error)}`);
    return false;
  }
  // The fixture has one operation; how the compiler stores its declared path is not this check's concern.
  const op = compiled.operations.find((candidate: any) => String(candidate.method).toLowerCase() === "post");
  if (op === undefined) {
    console.log(`fixture fragment: operation not found (skipped ${compiled.skipped.length})`);
    return false;
  }
  const sink: Captured[] = [];
  let tools: Awaited<ReturnType<typeof buildTools>>;
  try {
    tools = await buildTools(compiled, { methods: undefined, oauth: [], fetch: capturingFetch(sink) });
  } catch (error) {
    console.log(`fixture fragment: refused at tool build: ${describe(error)}`);
    return false;
  }
  if (tools[op.name] === undefined) {
    console.log(`fixture fragment: operation not exposed: ${op.name}`);
    return false;
  }
  const result = await runTool(tools, op.name, {}, sink);
  if (result.status !== "sent" || result.request === undefined) {
    console.log(`fixture fragment: not sent: ${result.status}`);
    return false;
  }
  const pathname = new URL(result.request.url).pathname;
  if (pathname !== "/oauth2/token") {
    console.log(`fixture fragment: sent to ${pathname}, expected /oauth2/token`);
    return false;
  }
  console.log(`fixture fragment: sent to ${pathname} (fragment dropped)`);
  return true;
}

async function malformedFixture(): Promise<boolean> {
  console.log("fixture malformed: GET /users/{id?}");
  const compiled = await compileSpec({ "/users/{id?}": { get: { operationId: "getUser", responses: OK } } });
  // A runtime failure alone is not enough: the import itself has to report the operation_path diagnostic.
  return await refusedAtImport("malformed", compiled, "get", "/users/{id?}", "users.getUser", "operation_path");
}

// (c) an allowReserved query value: a `#` would end the query (refused), a `%` that starts no escape is escaped.
async function reservedQueryFixture(): Promise<boolean> {
  console.log("fixture reserved query: GET /search?q= with % and #");
  const spec = {
    openapi: "3.0.0",
    info: { title: "Fixture reserved query", version: "1" },
    paths: {
      "/search": {
        get: {
          operationId: "search",
          parameters: [{ name: "q", in: "query", allowReserved: true, schema: { type: "string" } }],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
  const compiled = await compile(spec as any, { baseUrl: "https://example.test" });
  const op = compiled.operations.find((candidate: any) => String(candidate.method).toLowerCase() === "get");
  if (op === undefined) {
    console.log("fixture reserved query: operation not found");
    return false;
  }
  const sink: Captured[] = [];
  const tools = await buildTools(compiled, { methods: undefined, oauth: [], account: undefined, fetch: capturingFetch(sink) });
  const percent = await runTool(tools, op.name, { query: { q: "50%off" } }, sink);
  const query = percent.request === undefined ? "" : new URL(percent.request.url).search;
  if (query !== "?q=50%25off") {
    console.log(`fixture reserved query: % sent as ${query || percent.status}, expected ?q=50%25off`);
    return false;
  }
  for (const value of ["a#b", "a#", "#"]) {
    const hash = await runTool(tools, op.name, { query: { q: value } }, sink);
    if (hash.status === "sent") {
      console.log(`fixture reserved query: ${value} sent as ${hash.request?.url}`);
      return false;
    }
  }
  console.log("fixture reserved query: % escaped, interior, trailing and lone # refused");
  return true;
}

async function undeclaredPathParamFixture(): Promise<boolean> {
  const compiled = await compileSpec({ "/users/{id}": { get: { operationId: "getUser", responses: OK } } });
  return await refusedAtImport("undeclared path parameter", compiled, "get", "/users/{id}", "users.getUser", "operation_path");
}

async function requiredBodyFixture(): Promise<boolean> {
  const compiled = await compileSpec({
    "/get-items": { get: { operationId: "getItems", requestBody: bodyOf(true), responses: OK } },
    "/head-items": { head: { operationId: "headItems", requestBody: bodyOf(true), responses: OK } },
  });
  const get = await refusedAtImport("required body on GET", compiled, "get", "/get-items", "getItems.getGetItems", "request_body");
  const head = await refusedAtImport("required body on HEAD", compiled, "head", "/head-items", "headItems.headHeadItems", "request_body");
  return get && head;
}

async function optionalBodyFixture(): Promise<boolean> {
  const compiled = await compileSpec({
    "/get-items": { get: { operationId: "getItems", requestBody: bodyOf(false), responses: OK } },
  });
  const op = findOp(compiled, "get");
  if (op === undefined) {
    console.log("fixture optional body: operation not exposed");
    return false;
  }
  const tools = await buildTools(compiled, { methods: undefined, oauth: [], account: undefined, fetch: capturingFetch([]) });
  const tool: any = tools[op.name];
  const compiledBodyRemoved = !JSON.stringify((op as any).input ?? {}).includes('"body"');
  const acceptsWithoutBody = tool !== undefined && Schema.decodeUnknownOption(tool.input)({})._tag === "Some";
  const description = String(tool?.description ?? (op as any).description ?? "");
  const named = /request body is left out/i.test(description);
  console.log(`fixture optional body: tool=${tool !== undefined} compiledBodyRemoved=${compiledBodyRemoved} acceptsWithoutBody=${acceptsWithoutBody} descriptionNamesRemoval=${named}`);
  return tool !== undefined && compiledBodyRemoved && acceptsWithoutBody && named;
}

const fixtures: [string, () => Promise<boolean>][] = [
  ["fragment", fragmentFixture],
  ["malformed template", malformedFixture],
  ["reserved query", reservedQueryFixture],
  ["undeclared path parameter", undeclaredPathParamFixture],
  ["required body on GET/HEAD", requiredBodyFixture],
  ["optional body on GET", optionalBodyFixture],
];

async function passes(run: () => Promise<boolean>): Promise<boolean> {
  try {
    return await run();
  } catch (error) {
    console.log(`unexpected error: ${describe(error)}`);
    return false;
  }
}

export async function checkFixtures(): Promise<boolean> {
  let ok = true;
  for (const [name, run] of fixtures) {
    const passed = await passes(run);
    console.log(`${passed ? "PASS" : "FAIL"} fixture ${name}`);
    ok = passed && ok;
  }
  return ok;
}
