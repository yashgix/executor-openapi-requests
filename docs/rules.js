// The import rules of the change, as plain functions. Same logic as unfilledForms and the path checks in
// packages/apps/src/implementation/openapi-compile.ts, written without Effect so the page can run them.
(function (root) {
  const holes = (text) => [...text.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]);
  const route = (path) => {
    const declared = path.split("#")[0];
    const at = declared.indexOf("?");
    return at === -1 ? declared : declared.slice(0, at);
  };
  const unfilledForms = (routePart, names) => {
    const segments = routePart.split("/");
    const regexGroup = segments.some((segment) => {
      const literal = segment.replace(/\{[^{}]+\}/g, "");
      return literal.includes("\\") || /^\(.*[+*?|].*\)$/.test(literal);
    });
    return names.filter(
      (name) => regexGroup || segments.some((s) => s === ":" + name || s === "*" + name),
    );
  };
  // input: { method, path, params: [declared path parameter names], bodyRequired }
  function check(input) {
    const { method, path, params, bodyRequired } = input;
    const routePart = route(path);
    if (/[{}]/.test(routePart.replace(/\{[^{}]+\}/g, "")))
      return { verdict: "refused", code: "operation_path", reason: "The path has an unclosed or stray brace, so no request can fill it." };
    for (const name of holes(routePart))
      if (!params.includes(name))
        return { verdict: "refused", code: "operation_path", reason: "The path uses {" + name + "}, but the operation declares no path parameter named " + name + "." };
    const used = new Set(holes(path.split("#")[0]));
    const unused = params.filter((name) => !used.has(name));
    const unfilled = unfilledForms(routePart, unused);
    if (unfilled.length > 0)
      return { verdict: "refused", code: "operation_path", reason: "The path declares " + unfilled.join(", ") + " in a form that is never filled (:name, *name or a pattern such as (\\d+)). Write {name}." };
    if ((method === "GET" || method === "HEAD") && bodyRequired)
      return { verdict: "refused", code: "request_body", reason: "A GET or HEAD request cannot carry a body, and this operation requires one." };
    if (unused.length > 0)
      return { verdict: "kept", note: "Its path does not hold " + unused.join(", ") + ", so any value given is not sent." };
    return { verdict: "kept", note: "" };
  }
  const api = { check, holes, route, unfilledForms };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.importRules = api;
})(typeof window !== "undefined" ? window : globalThis);
