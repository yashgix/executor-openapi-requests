# Reproduce

## 1. The scenarios (need Docker)
Run from a shell where `PORTFOLIO` is this portfolio folder, the one that holds `README.md` and `patches/`. `EXECUTOR` is the clone.
```
export PORTFOLIO="$PWD"
export EXECUTOR="$HOME/executor"
git clone https://github.com/UsefulSoftwareCo/executor "$EXECUTOR"
cd "$EXECUTOR" && git checkout 45e39ee12
git am --3way "$PORTFOLIO/patches/pr2-query-as-sent.patch" "$PORTFOLIO/patches/pr1-import-diagnostics.patch"
bun install
bun run e2e:self-host --test-name "An app's fetch sends its query to the upstream exactly as written"
bun run e2e:self-host --test-name "Imported OpenAPI query parameters reach the upstream as OpenAPI serializes each style"
bun run e2e:self-host --test-name "OpenAPI import reports a misnamed path parameter"
```
The `e2e:self-host` commands start a self-hosted stack and need the upstream container setup described in the project's `DEVELOPMENT.md`. For the control runs, check out `45e39ee12` again in `$EXECUTOR`, copy only the three files from `$PORTFOLIO/tests/` into `e2e/tests/`, add their entries to `e2e/test-plan.ts` (copy them from the patches), and run the same commands. They must fail. The keepalive case in `app-fetch-query` shows that the request and body arrive. The upstream server cannot observe the keepalive flag.

## 2. The page's import rules
```
cd "$PORTFOLIO" && node --test tests/rules-port.test.mjs
```

## 3. The offline sweep and gate (`harness/`)
The scripts import the compiler and the tools builder from an Executor checkout, so run them from `$EXECUTOR/packages/apps` with this folder's `harness/` copied in. They also need Node 24 or Bun and a folder of public OpenAPI specs (`<specs-dir>`). The spec files are public and are not bundled here because they are large. `harness/configs.ts` lists the apps and their import settings. Use the tree with the patches for "after" and a second checkout of `45e39ee12` without them for "before".

```
cp -R "$PORTFOLIO/reproduce/harness" "$EXECUTOR/packages/apps/harness"
cd "$EXECUTOR/packages/apps"
node harness/sweep.ts <configs-dir> <specs-dir> sweep-after.jsonl      # patched checkout
# in the unpatched checkout: node harness/sweep.ts <configs-dir> <specs-dir> sweep-before.jsonl
python3 "$PORTFOLIO/reproduce/compare.py" sweep-before.jsonl sweep-after.jsonl
node harness/gate.ts <configs-dir> <specs-dir> "$PORTFOLIO/data/gate-baseline.json"
```
`harness/rules-fixtures.ts` is the fixture run behind `docs/compiler-fixtures.recorded.json`. There is no single command that fetches the specs and runs everything.

## 4. The before and after demo
`demo/demo.ts` runs the same tool calls against a local server on two trees, and `demo/render.py` prints the table.
