import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import * as bridgeCli from "../src/index.ts";

const packageRoot = path.resolve(import.meta.dirname, "..");
test("CLI exports stay generic and free of product-specific naming", () => {
  const exportNames = Object.keys(bridgeCli);
  assert.equal(
    exportNames.some((name) => /telegram|openclaw|bridge-core/i.test(name)),
    false
  );
});
test("CLI source stays a thin client over the standalone bridge API", async () => {
  const source = await readFile(path.join(packageRoot, "src", "index.ts"), "utf8");
  assert.match(source, /from "@uncensoredcode\/openbridge\/server"/);
  assert.doesNotMatch(source, /@uncensoredcode\/openbridge\/runtime/);
  assert.doesNotMatch(
    source.replaceAll("@uncensoredcode/openbridge/server", ""),
    /telegram|openclaw/i
  );
});
