// The request OpenAPI 3.x serialization rules give for a tool input, built with openapi-fetch's
// per-parameter serializers (style, explode, allowReserved), compared with what Executor built.
import {
  serializeArrayParam,
  serializeObjectParam,
  serializePrimitiveParam,
} from "/ref/node_modules/openapi-fetch/dist/index.mjs";
import type { Captured } from "./lib.ts";

type Parameter = {
  name: string;
  in: string;
  style?: string;
  explode?: boolean;
  allowReserved?: boolean;
  content?: Record<string, unknown>;
};
type Operation = {
  method: string;
  path: string;
  baseUrl: string;
  request: { parameters: Parameter[] };
};

export interface Finding {
  readonly kind: "match" | "encoding" | "wrong" | "unsure";
  /** Short labels of each difference, such as `query:form-explode-false` or `path:missing`. */
  readonly notes: readonly string[];
  /** The query is byte for byte the reference's, in parameter order; absent when a rule is missing. */
  readonly exact?: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const nested = (v: unknown) =>
  Array.isArray(v) ? v.some((x) => x !== null && typeof x === "object") : isObject(v) && Object.values(v).some((x) => x !== null && typeof x === "object");

const styleOf = (p: Parameter) => p.style ?? (p.in === "query" || p.in === "cookie" ? "form" : "simple");
const explodeOf = (p: Parameter) => p.explode ?? styleOf(p) === "form";

/** One parameter as OpenAPI serializes it, or undefined when the reference has no rule for it. */
function reference(p: Parameter, value: unknown): string | undefined {
  if (p.content !== undefined) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return p.in === "header" ? text : `${encodeURIComponent(p.name)}=${encodeURIComponent(text)}`;
  }
  if (nested(value)) return undefined;
  const style = styleOf(p);
  // openapi-fetch has no unexploded pipe/space object rule; this is the OpenAPI 3.2 style table row.
  if (isObject(value) && !explodeOf(p) && (style === "pipeDelimited" || style === "spaceDelimited"))
    return `${p.name}=${Object.entries(value).flat().map((v) => encodeURIComponent(String(v))).join(style === "pipeDelimited" ? "%7C" : "%20")}`;
  if (style === "deepObject" && !isObject(value)) return undefined;
  const options = { style, explode: explodeOf(p), allowReserved: p.allowReserved === true || p.in === "header" };
  // openapi-fetch writes parameter names unescaped; OpenAPI escapes them like values.
  const name = p.in === "query" ? encodeURIComponent(p.name) : p.name;
  if (Array.isArray(value)) return serializeArrayParam(name, value, options);
  if (isObject(value)) return serializeObjectParam(name, value, options);
  if (p.in === "header") return String(value);
  if (p.in === "path") {
    const text = encodeURIComponent(String(value));
    return options.style === "label" ? `.${text}` : options.style === "matrix" ? `;${p.name}=${text}` : text;
  }
  return serializePrimitiveParam(name, value, options);
}

// Characters whose escaped and literal forms a server tells apart in a query or path.
const significant = new Set([",", " ", "&", "=", "+", ";", "#", "?", "/", "."]);
const canonical = (text: string) =>
  text.replace(/%[0-9A-Fa-f]{2}/g, (escape) => {
    const char = String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    return significant.has(char) ? escape.toUpperCase() : char;
  });
const decoded = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};
const keyOf = (part: string) => part.split("=")[0] ?? "";
// Sorted by name only, so repeated names keep their order: `ids=b&ids=a` is not `ids=a&ids=b`.
const byName = (a: string, b: string) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0);
const pairs = (query: string) =>
  query
    .split("&")
    .filter((part) => part !== "")
    .map((part) => canonical(part))
    .sort(byName);
/** RFC 3986 path and query characters: unreserved, sub-delims, `:@/?` and valid escapes. */
const uriText = /^(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2})*$/;
/** The reference in the form OpenAPI 3.2 Appendix E gives: no raw `|`, brackets or other illegal characters. */
const legal = (text: string) =>
  text.replace(/[[\]{}|^`\\]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** Header parameters OpenAPI says to ignore. */
const ignoredHeaders = new Set(["accept", "content-type", "authorization"]);
/** Headers a fetch caller cannot set; the runtime computes them. */
const forbiddenHeaders = new Set(["content-length", "host", "connection"]);

export function compare(
  op: Operation,
  input: Record<string, any>,
  sent: Captured,
  credentials: { readonly query: readonly string[]; readonly header: readonly string[] },
): Finding {
  const notes: string[] = [];
  let kind: Finding["kind"] = "match";
  const raise = (next: Finding["kind"], note: string) => {
    const label = `${next}:${note}`;
    if (!notes.includes(label)) notes.push(label);
    const rank = { match: 0, encoding: 1, unsure: 2, wrong: 3 };
    if (rank[next] > rank[kind]) kind = next;
  };
  const url = new URL(sent.url);
  const [rawPath = "", rawQuery = ""] = (sent.url.replace(/^[^:]+:\/\/[^/]*/, "").split("#")[0] ?? "").split(/\?(.*)/s);
  if (!uriText.test(rawPath) || !uriText.test(rawQuery)) raise("wrong", "uri:invalid-character");
  const groups: Record<string, string> = { path: "path", query: "query", header: "headers", cookie: "cookie" };
  const valueOf = (p: Parameter) => input[groups[p.in] ?? p.in]?.[p.name];

  // Path: fill the template the reference's way, then compare segment by segment.
  // Catalog paths can carry a `#fragment` suffix (operation disambiguation); it never reaches the HTTP path.
  // Some catalog paths also carry a query template (`/x/?from={from}`): its `{name}`s are path parameters too.
  let [template = "", fixedQuery] = op.path.split("#")[0]!.split("?");
  let expectedPath = new URL(op.baseUrl).pathname.replace(/\/$/, "") + template;
  let pathRule = true;
  for (const p of op.request.parameters.filter((x) => x.in === "path")) {
    const ref = reference(p, valueOf(p));
    if (ref === undefined) {
      raise("unsure", "path:no-reference-rule");
      pathRule = false;
      continue;
    }
    expectedPath = expectedPath.replaceAll(`{${p.name}}`, ref);
    fixedQuery = fixedQuery?.replaceAll(`{${p.name}}`, ref);
  }
  if (pathRule && canonical(url.pathname) !== canonical(expectedPath))
    raise(decoded(url.pathname) === decoded(expectedPath) ? "encoding" : "wrong", `path:${styleSummary(op, "path")}`);

  // Query: compare name=value pairs of the parameters the reference has a rule for. Credential
  // parameters and parameters without a rule are left out on both sides.
  const expectedParts: string[] = [];
  if (fixedQuery) expectedParts.push(...fixedQuery.split("&"));
  const skipped = new Set(credentials.query);
  // Two exploded objects with a common key give the same name twice; OpenAPI leaves that undefined.
  const exploded = op.request.parameters
    .filter((x) => x.in === "query" && explodeOf(x) && styleOf(x) === "form" && isObject(valueOf(x)))
    .flatMap((x) => Object.keys(valueOf(x)));
  for (const key of exploded.filter((key, i) => exploded.indexOf(key) !== i)) {
    raise("unsure", "spec:exploded-objects-share-keys");
    skipped.add(key);
  }
  for (const p of op.request.parameters.filter((x) => x.in === "query")) {
    const value = valueOf(p);
    if (value === undefined || skipped.has(p.name)) continue;
    if (p.name === "") {
      raise("match", "spec:empty-parameter-name");
      continue;
    }
    if (isObject(value) && explodeOf(p) && styleOf(p) === "form" && Object.keys(value).some((key) => skipped.has(key))) continue;
    const ref = reference(p, value);
    if (ref === undefined) {
      raise("unsure", `query:${styleOf(p)}:no-reference-rule`);
      skipped.add(p.name);
      if (isObject(value) && explodeOf(p)) for (const key of Object.keys(value)) skipped.add(key);
      continue;
    }
    if (ref !== "") expectedParts.push(ref);
  }
  const nameOf = (part: string) => decoded(keyOf(part).replaceAll("+", " ")).replace(/\[.*$/, "");
  const sentQuery = url.search
    .slice(1)
    .split("&")
    .filter((part) => part !== "" && !skipped.has(nameOf(part)))
    .join("&");
  const exact = notes.some((note) => note.includes("no-reference-rule") || note.includes("share-keys"))
    ? undefined
    : sentQuery === legal(expectedParts.join("&"));
  // A form-encoded `+` is a space to the servers that read queries as forms; the reference writes %20.
  if (sentQuery.includes("+")) raise("encoding", "query:plus-for-space");
  const actual = pairs(sentQuery.replaceAll("+", "%20"));
  const expected = pairs(expectedParts.join("&"));
  if (actual.join("&") !== expected.join("&")) {
    const loose = (list: string[]) => list.map(decoded).sort(byName).join("&");
    raise(loose(actual) === loose(expected) ? "encoding" : "wrong", `query:${styleSummary(op, "query")}`);
  }
  for (const p of op.request.parameters.filter((x) => x.in === "query" && !explodeOf(x))) {
    const value = valueOf(p);
    if (!Array.isArray(value) || nested(value)) continue;
    const delimiter = { form: ",", pipeDelimited: "|", spaceDelimited: " " }[styleOf(p)];
    if (delimiter === undefined) continue;
    // Servers split then decode (RFC 6570) or decode then split. Lost only if neither recovers it.
    const want = JSON.stringify(value.map(String));
    const strict = splitItems(sentQuery, p.name, delimiter, true) === want;
    const lenient = splitItems(sentQuery, p.name, delimiter, false) === want;
    if (!strict && !lenient) raise("wrong", "query:explode-false-items-lost");
    else if (!strict) raise("encoding", "query:explode-false-delimiter-escaped");
  }

  // Headers: simple style, never percent-encoded.
  for (const p of op.request.parameters.filter((x) => x.in === "header")) {
    const value = valueOf(p);
    if (value === undefined) continue;
    const name = p.name.toLowerCase();
    if (ignoredHeaders.has(name)) {
      raise("match", "spec:header-parameter-ignored-by-openapi");
      continue;
    }
    if (forbiddenHeaders.has(name)) {
      raise("match", "runtime:forbidden-request-header");
      continue;
    }
    if (credentials.header.includes(name)) {
      raise("match", "config:header-parameter-is-credential");
      continue;
    }
    const ref = reference(p, value);
    const got = sent.headers[p.name.toLowerCase()];
    if (ref === undefined) raise("unsure", "header:nested-value");
    else if (got !== ref) raise("wrong", got === undefined ? "header:missing" : "header:value");
  }

  // Cookies: form style name=value pairs in one Cookie header.
  const cookies = op.request.parameters.filter((x) => x.in === "cookie" && valueOf(x) !== undefined);
  if (cookies.length) {
    const jar = (sent.headers.cookie ?? "").split(/;\s*/).filter(Boolean).sort();
    const want = cookies.map((p) => reference(p, valueOf(p)) ?? "").sort();
    if (jar.join(";") !== want.join(";")) raise("wrong", "cookie:value");
  }

  compareBody(input, sent, raise);
  return { kind, notes, ...(exact === undefined ? {} : { exact }) };
}

function compareBody(
  input: Record<string, any>,
  sent: Captured,
  raise: (kind: Finding["kind"], note: string) => void,
) {
  if (input.body === undefined) return;
  const type = String(input.contentType ?? "").toLowerCase();
  const sentType = (sent.headers["content-type"] ?? "").toLowerCase();
  if (sent.body === undefined) return raise("wrong", "body:missing");
  if (/json/.test(type)) {
    if (!sentType.startsWith(type)) raise("wrong", "body:content-type");
    let parsed: unknown;
    try {
      parsed = JSON.parse(sent.body);
    } catch {
      return raise("wrong", "body:not-json");
    }
    if (JSON.stringify(sortKeys(parsed)) !== JSON.stringify(sortKeys(input.body))) raise("wrong", "body:json-value");
  } else if (type === "application/x-www-form-urlencoded") {
    if (!isObject(input.body) || nested(input.body)) return raise("unsure", "body:form-nested");
    const form = new URLSearchParams(sent.body);
    for (const [key, value] of Object.entries(input.body)) {
      const want = (Array.isArray(value) ? value : [value]).map(String);
      if (form.getAll(key).join("\u0000") !== want.join("\u0000")) raise("wrong", "body:form-field");
    }
  } else if (type.startsWith("multipart/")) {
    if (!isObject(input.body)) return raise("unsure", "body:multipart-shape");
    for (const key of Object.keys(input.body))
      if (!sent.body.includes(`name="${key}"`)) raise("wrong", "body:multipart-field");
  } else if (type.startsWith("text/")) {
    if (sent.body !== input.body) raise("wrong", "body:text");
  }
}

/** The items a server recovers from an unexploded list, splitting before or after decoding. */
function splitItems(query: string, name: string, delimiter: string, splitFirst: boolean) {
  const part = query
    .split("&")
    .find((pair) => decoded((pair.split("=")[0] ?? "").replaceAll("+", " ")) === name);
  if (part === undefined) return "missing";
  const raw = part.slice(part.indexOf("=") + 1);
  const decode = (item: string) => decoded(item.replaceAll("+", " "));
  if (!splitFirst) return JSON.stringify(decode(raw).split(delimiter));
  const literal = delimiter === " " ? /%20|\+/ : delimiter === "|" ? /\||%7C/i : delimiter;
  return JSON.stringify(raw.split(literal).map(decode));
}

function styleSummary(op: Operation, where: string) {
  const styles = new Set(
    op.request.parameters
      .filter((p) => p.in === where)
      .map((p) => (p.content ? "content" : `${styleOf(p)}${explodeOf(p) ? "" : "-noexplode"}`)),
  );
  return [...styles].sort().join("+") || "none";
}

const sortKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : isObject(value)
      ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]))
      : value;
