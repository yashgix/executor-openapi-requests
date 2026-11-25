# Architecture: how an OpenAPI tool call becomes a request

Executor imports an OpenAPI document and compiles each operation into a tool. At call time it serializes the tool's input into a request and sends it. This note covers the two places the change touches. Paths are in `UsefulSoftwareCo/executor` at `v2`. The code described is the same at `45e39ee12`, where the benchmark ran, and at `7cabe226e`, where the patches now apply.

## 1. Import: `packages/apps/src/implementation/openapi-compile.ts`

`compileOpenApiDocument` turns each operation into a generated tool with an input schema (`path`, `query`, `headers`, `body`) and a record of how to build its request. An operation the importer cannot represent is left out and recorded in `skipped` with a code and a reason. That is where this change adds its checks.

```
operation (method, path, parameters, requestBody)
   ├─ stray brace in the route?                      → skipped: operation_path
   ├─ route placeholder with no declared parameter?   → skipped: operation_path
   ├─ declared path parameter written as :name,
   │  *name or beside a regex group?                  → skipped: operation_path
   ├─ GET or HEAD with a required body?               → skipped: request_body
   └─ otherwise                                       → tool
        ├─ optional GET or HEAD body: left out of the input, named in the description
        └─ declared path parameter the path does not hold: kept, named in the description
```

Helper functions: `placeholdersOf(text)` reads `{name}` placeholders. `pathRoute(path)` is the part before `?` and `#`. `unfilledForms(route, names)` returns the declared names the route writes in a form OpenAPI never fills. A placeholder after `?` counts as held, because the builder fills it, and one after `#` does not, because the fragment is dropped.

## 2. Request: `openapi-request.ts` and `packages/telemetry/src/context.ts`

`openapi-request.ts` serializes each parameter by its OpenAPI style and explode setting, then appends the query to the URL. It escapes only what a URI query cannot hold, keeps an existing percent escape as it is, and refuses a reserved value containing `#` because that would cut the query short.

The runtime then sends the request through `invocationFetch`, which in the original code passed it through `HttpClientRequest.fromWeb`. `fromWeb` reads the URL's query into a list of parameters, and the Effect HTTP client appends them again with form encoding. That is the step that rewrote `tags=red,blue` to `tags=red%2Cblue`. `asSent` in `context.ts` keeps `fromWeb(request)` for the method, headers, body and signal, clears the parsed parameters, and sets the original URL again without its fragment. A bare trailing `?` survives.

The re-encoding affects OpenAPI tools and the `ctx.fetch` a tool receives. App code's global `fetch` is not affected.

## 3. Tests

Upstream bans unit tests, so each change has end-to-end scenarios that run on the self-host stack in a disposable container, with a loopback upstream that echoes what it received:
- `openapi-query-styles.spec.ts`: each style and explode setting, and the refusal of `#` in a reserved value.
- `app-fetch-query.spec.ts`: `ctx.fetch` keeps the query, a bare `?`, a keepalive POST and a streamed POST.
- `openapi-import-diagnostics.spec.ts`: every refusal and every kept case above, plus calls that show the kept tools send the right URL.

Each scenario is checked against a control: real upstream code with only the scenarios added must fail it. The query-encoding change has a second control, the earlier fetch code that lost the bare `?`.

## 4. Offline measurement

`reproduce/harness` generates an input for each operation from the tool's own schema, runs the tool against a fetch that records the request, and compares it with the OpenAPI serialization rules in a separate checker (`oracle.ts`). The result per operation and input profile is `match`, `encoding`, `unsure` or `wrong`. A gate stores one verdict per operation for 18 apps and fails on anything worse.

## 5. Limits

See the Limits section of `docs/index.html` and the PR descriptions. The main ones: an undeclared placeholder after `?` is not diagnosed, a kept unused path parameter stays required in the input, a literal `%2F` under `allowReserved` is still sent as `%252F`, and no live provider was called.
