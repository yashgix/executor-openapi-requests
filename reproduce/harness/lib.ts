// Drives Executor's own OpenAPI compile and request path with a fetch that never leaves the process.
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { compileOpenApiDocument } from "../src/implementation/openapi-compile.ts";
import { openapiToolsEffect } from "../src/implementation/openapi.ts";

export interface Captured {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

export interface AppConfig {
  readonly allowedOrigin?: string | readonly string[];
  readonly securitySchemes?: Record<string, Record<string, unknown>>;
  readonly baseUrl?: string;
  readonly pathPrefix?: string;
  readonly fallbackSecurity?: readonly Record<string, readonly string[]>[];
  readonly methods?: Record<
    string,
    readonly { scheme: string; field: string; part: string; prefix: string }[]
  >;
  readonly oauth?: readonly string[];
}

export const readSpec = (path: string) => JSON.parse(readFileSync(path, "utf8"));

export const compile = (document: Record<string, unknown>, config: AppConfig = {}) =>
  Effect.runPromise(
    compileOpenApiDocument({ name: "API" }, document as never, {
      ...(config.allowedOrigin === undefined ? {} : { allowedOrigin: config.allowedOrigin }),
      ...(config.securitySchemes === undefined
        ? {}
        : { securitySchemes: config.securitySchemes as never }),
      ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
      ...(config.pathPrefix === undefined ? {} : { pathPrefix: config.pathPrefix }),
      ...(config.fallbackSecurity === undefined
        ? {}
        : { fallbackSecurity: config.fallbackSecurity as never }),
    }),
  );

/** A fetch that records the request and answers 200 `{}`; the request never reaches a network. */
export function capturingFetch(sink: Captured[]): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const body = request.body === null ? undefined : await request.text();
    sink.push({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      ...(body === undefined ? {} : { body }),
    });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
}

type Compiled = Awaited<ReturnType<typeof compile>>;
type Account = { method: string; fields: Record<string, unknown> };

export const buildTools = (
  compiled: Compiled,
  options: {
    methods: AppConfig["methods"];
    oauth: readonly string[];
    account: Account | undefined;
    fetch: typeof fetch;
    only?: readonly unknown[];
  },
) =>
  Effect.runPromise(
    openapiToolsEffect({
      operations: options.only ?? compiled.operations,
      definitions: compiled.definitions,
      methods: (options.methods ?? {}) as never,
      oauth: options.oauth,
      ...(options.account === undefined ? {} : { account: options.account }),
      fetch: options.fetch,
    }),
  );

type Tools = Awaited<ReturnType<typeof buildTools>>;

/** Run one tool. The result is the captured request, or the tagged failure Executor returns. */
export async function runTool(tools: Tools, name: string, input: unknown, sink: Captured[]) {
  const tool = tools[name];
  if (tool === undefined) return { status: "missing" as const };
  sink.length = 0;
  const exit = await Effect.runPromiseExit(tool.run({} as never, input) as never);
  if (exit._tag === "Success") return { status: "sent" as const, request: sink[0] };
  const failure = JSON.stringify(exit.cause);
  return { status: "failed" as const, failure, request: sink[0] };
}

/** An account whose fields are all `value`, for every method and OAuth entry a config declares. */
export function placeholderAccount(config: AppConfig, value: string): Account | undefined {
  const [method, bindings] = Object.entries(config.methods ?? {})[0] ?? [];
  if (method !== undefined && bindings !== undefined)
    return { method, fields: Object.fromEntries(bindings.map(({ field }) => [field, value])) };
  const [oauth] = config.oauth ?? [];
  return oauth === undefined ? undefined : { method: oauth, fields: { access_token: value } };
}
