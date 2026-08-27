import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { version } from "../src/cli/version.ts";

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8"));

test("version returns the version field from package.json", () => {
  assert.equal(version(process.cwd()), pkg.version);
});

test("version is resolved from the module's own package.json, independent of cwd", () => {
  assert.equal(version("/"), pkg.version);
});
