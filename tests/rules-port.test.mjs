// Checks the page's JavaScript rules against what the real compiler did with the same fixtures.
// Run: node --test tests/rules-port.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const { check } = createRequire(import.meta.url)("../docs/rules.js");
const recorded = JSON.parse(readFileSync(new URL("../docs/compiler-fixtures.recorded.json", import.meta.url), "utf8"));
const exposed = new Set(recorded.exposed.map((entry) => entry.name));
const refusedPaths = new Set(recorded.refused.map((entry) => entry.path));

// name is the compiler's tool name for an operation that stayed exposed, path is read from the refused list
const cases = [
  { tool: "ping.getPing", path: "/ping", params: [] },
  { tool: "items.itemWithExtra", path: "/items/{id}", params: ["id", "extra"] },
  { tool: "search.searchWithQueryTemplate", path: "/search?limit={limit}", params: ["limit"] },
  { tool: "note.fragmentTemplate", path: "/note#view={id}", params: ["id"] },
  { tool: "files.customVerb", path: "/files/{fileId}:copy", params: ["fileId", "copy"] },
  { tool: "orders.verbPrefix", path: "/orders/{id}:validate", params: ["id", "v"] },
  { tool: "find.undeclaredQueryPlaceholder", path: "/find?limit={limit}", params: [] },
  { tool: "itemsArchived.literalParentheses", path: "/items(archived)/{id}", params: ["id", "extra"] },
  { tool: "odata.odataLike", path: "/odata/getCounts(period='{period}')/{id}", params: ["period", "id", "extra"] },
  { path: "/jobs/:jobId", params: ["jobId"] },
  { path: "/files/{id}/*rest", params: ["id", "rest"] },
  { path: "/tags/(\\d+)/active", params: ["optionId"] },
  { path: "/zip/([0-9]+)/done", params: ["zip"] },
  { path: "/reports/{report_slug}", params: ["report_id"] },
];

for (const c of cases) {
  test(`${c.path} ${c.params.join(",")}`, () => {
    const compiler = c.tool ? (exposed.has(c.tool) ? "kept" : "missing") : refusedPaths.has(c.path) ? "refused" : "missing";
    assert.notEqual(compiler, "missing", "fixture is in the recorded compiler output");
    assert.equal(check({ method: "GET", path: c.path, params: c.params }).verdict, compiler);
  });
}

test("a stray brace and a required GET body are refused, as in the gate fixtures", () => {
  assert.equal(check({ method: "GET", path: "/users/{id?}", params: [] }).verdict, "refused");
  assert.equal(check({ method: "GET", path: "/x", params: [], bodyRequired: true }).verdict, "refused");
  assert.equal(check({ method: "POST", path: "/x", params: [], bodyRequired: true }).verdict, "kept");
});
