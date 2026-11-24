// Evaluate each sampled app's openapi.ts and record its options. Inline documents go to their own file.
// Usage: node harness/configs.ts /data/sample.json /data/apps-src /out/configs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [samplePath = "", sourceDir = "", outDir = ""] = process.argv.slice(2);
const { ids } = JSON.parse(readFileSync(samplePath, "utf8")) as { ids: string[] };
mkdirSync(join(outDir, "documents"), { recursive: true });

const configs: Record<string, unknown> = {};
for (const id of ids) {
  try {
    const module = await import(join(sourceDir, id, "openapi.ts"));
    const options = module.options ?? Object.values(module).find((v) => typeof v === "object");
    if (options === undefined) throw new Error("no exported options");
    const { source, ...rest } = options;
    if ("document" in source)
      writeFileSync(join(outDir, "documents", `${id}.json`), JSON.stringify(source.document));
    configs[id] = { ...rest, source: "url" in source ? { url: source.url } : { inline: true } };
  } catch (error) {
    configs[id] = { error: String(error).slice(0, 300) };
  }
}
writeFileSync(join(outDir, "configs.json"), JSON.stringify(configs, null, 1));
const failed = Object.entries(configs).filter(([, c]) => "error" in (c as object));
console.log(`${ids.length} configs, ${failed.length} not evaluable`);
for (const [id, c] of failed) console.log(id, (c as { error: string }).error);
