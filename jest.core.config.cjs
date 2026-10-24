/**
 * jest.core.config.cjs — The core's tests, run as an app with no product module (ADR-054 §4)
 *
 *   npm run test:core
 *
 * The repository's jest configuration (package.json), minus every test platform/modules/
 * manifest.json assigns to a module and the tests of the app's own module list (seamTests), with
 * PF_TEST_MODULES=none so jest.setup registers no module. A consumer that uses no module runs
 * exactly this: the core, alone, must pass.
 */
"use strict";

const path = require("path");
const {
  loadManifest,
  moduleIds,
  ownedPaths,
  zonePaths,
} = require("./scripts/module-manifest.cjs");

const base = require("./package.json").jest;
const manifest = loadManifest();

/** A path (file or directory) as a jest path-ignore pattern anchored at the root. */
const pattern = (rel) =>
  `<rootDir>/${rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${path.extname(rel) ? "$" : "/"}`;

const moduleTests = moduleIds(manifest).flatMap((id) => [
  ...zonePaths(manifest, id),
  ...ownedPaths(manifest, id),
]);

module.exports = {
  ...base,
  rootDir: __dirname,
  testPathIgnorePatterns: [
    ...(base.testPathIgnorePatterns ?? ["/node_modules/"]),
    ...[...moduleTests, ...manifest.seamTests].map(pattern),
  ],
};
