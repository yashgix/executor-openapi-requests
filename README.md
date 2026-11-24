# openapi-requests

**Live page:** https://yashgix.github.io/executor-openapi-requests/ · **Pull requests:** [#2590](https://github.com/UsefulSoftwareCo/executor/pull/2590) and [#2595](https://github.com/UsefulSoftwareCo/executor/pull/2595)

Two changes to [Executor](https://github.com/UsefulSoftwareCo/executor) so its OpenAPI tools send the request the spec describes, with the tests, measurements and limits for each.

Executor turns OpenAPI specs into tools an agent can call. Checking what those tools send showed two problems. The query string was rewritten on the way out (`tags=red,blue` went out as `tags=red%2Cblue`, `a%20b` as `a+b`). And some operations compiled into tools that could never work, such as a path with `{report_slug}` whose operation declares `report_id`.

| | Upstream `v2` `45e39ee12` | With the changes |
|---|---|---|
| `tags=red,blue` | sent as `tags=red%2Cblue` | sent as `tags=red,blue` |
| `q=a%20b` | sent as `q=a+b` | sent as `q=a%20b` |
| `/jobs/:jobId` declaring `jobId` | exposed, calls `/jobs/:jobId` | refused at import with the reason |
| `/items/{id}` declaring an extra `extra` | exposed | exposed, description says `extra` is not sent |

**Measured, both changes together.** In two offline samples (134 apps, 22,954 operations, 68,090 generated inputs), 5,198 operations now send a query that matches the spec, 157 operations that failed on every call are named at import, and no operation that worked is refused. A regression gate over 18 apps and 4,792 operations reports nothing worse. The two changes were not measured separately. Six queries changed bytes but stay equivalent (`*` became `%2A`).

**Status.** Both changes are open on `v2` as separate pull requests: [PR #2590](https://github.com/UsefulSoftwareCo/executor/pull/2590) (query change) and [PR #2595](https://github.com/UsefulSoftwareCo/executor/pull/2595) (import change). As of 24 Nov 2026 neither has checks, comments or reviews. Nothing has been merged or accepted. The page reads its PR links from `docs/links.json`.

**Boundaries.** Out of scope: with `allowReserved`, a literal `%2F` is still sent as `%252F`, which departs from OpenAPI. That is older behaviour from `swagger-client` and belongs in its own change. An undeclared placeholder after `?` in a path is not diagnosed. The keepalive scenario shows that the request and its body arrive, not that the flag is forwarded, because the upstream server cannot observe it. No live provider was called, so the bytes are verified and provider acceptance is not.

## Contents
- `docs/index.html`: the write-up as one page, with two small demos, diagrams, the evidence table and the reproduction steps. It has an Overview tab and a Technical details tab, and follows the system light or dark theme.
- `patches/`: `pr2-query-as-sent.patch` (query change) and `pr1-import-diagnostics.patch` (import change), both against `v2` `45e39ee12`.
- `tests/`: the three end-to-end scenarios the patches add, and `rules-port.test.mjs`, which checks the page's import rules against recorded compiler output.
- `docs/links.json`: the PR links the page shows. Both PR links are set.
- `reproduce/`: the offline measurement harness and a before and after demo.
- `data/results.json`: the recorded numbers. `data/gate-baseline.json` is the gate baseline.
- `screenshots/`: the page at desktop and mobile width, in light and dark.

## Reproduce
`PORTFOLIO` is the folder that holds this README and `patches/`. `EXECUTOR` is a fresh clone of [UsefulSoftwareCo/executor](https://github.com/UsefulSoftwareCo/executor). Both patches are against `v2` at `45e39ee12`.
```
export PORTFOLIO="$PWD"
export EXECUTOR="$HOME/executor"
git clone https://github.com/UsefulSoftwareCo/executor "$EXECUTOR"
cd "$EXECUTOR" && git checkout 45e39ee12
git am --3way "$PORTFOLIO/patches/pr2-query-as-sent.patch" "$PORTFOLIO/patches/pr1-import-diagnostics.patch"
bun install
bun run e2e:self-host --test-name "OpenAPI import reports a misnamed path parameter"
cd "$PORTFOLIO" && node --test tests/rules-port.test.mjs
```
`git am` needs `user.name` and `user.email` set. The scenarios need Docker. `reproduce/README.md` has the other scenario commands, the control runs and the offline harness.

## Test results
Which checks ran on which commit:

| Check | Query change, final commit `d5733f56b` | Import change, final tree (same tree as `534287040`) |
|---|---|---|
| Scenarios pass, and fail on real upstream | yes | yes |
| Format, lint, typecheck, `e2e:check` | `bun run check`, 17 of 17 | changed files, 9 projects, `e2e:check` |
| Regression gate, 18 apps, 4,792 operations | not run alone | not run alone. Run on both changes together, with the final import code and the query change: nothing worse |
| Release-note check, `e2e:check-description` | yes | earlier revision, same four files |

The 68,090-input sweep ran on both changes together, on an earlier revision of the import change that differs only in a regex-group rule narrowed afterwards. `apps-version` and `pr:check` as a whole were not run, because `v2` and `main` share no history. The scenarios ran once, in a container.

## Author
Yash Gupta · [GitHub](https://github.com/yashgix) · [LinkedIn](https://www.linkedin.com/in/yash-guptaix/)

This is an independent contribution and is not affiliated with the Executor team. See `NOTICE.md`.
