import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";
import regexpPlugin from "eslint-plugin-regexp";
import { createRequire } from "node:module";

// ADR-054 D3: the core/module boundary, drawn from platform/modules/manifest.json by the one
// reader of the manifest (scripts/module-manifest.cjs), so the lint zones and the manifest tests
// cannot disagree.
const { lintBoundaryConfigs } = createRequire(import.meta.url)(
  "./scripts/module-manifest.cjs"
);
const everyNeedsNonempty = createRequire(import.meta.url)(
  "./eslint-rules/every-needs-nonempty.cjs"
);

// The import plugin instance next's config registers: a config object may only use a plugin
// rule where it names the plugin, and naming a second instance under the same key is an error.
const importPlugin = nextVitals.find((config) => config.plugins?.import)?.plugins.import;
if (!importPlugin)
  throw new Error("eslint-config-next no longer registers eslint-plugin-import");

const eslintConfig = [
  {
    ignores: ["coverage/**", ".next/**", "node_modules/**", "next-env.d.ts", "k6/**"],
  },
  ...nextVitals,
  ...nextTypescript,
  prettier,
  regexpPlugin.configs["flat/recommended"],
  {
    rules: {
      "max-lines-per-function": [
        "warn",
        { max: 300, skipBlankLines: true, skipComments: true },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // CommonJS scripts (scripts/*.cjs) load modules with require by definition.
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // A jest.mock factory is hoisted above every import, so it can only reach a shared test
    // helper through require (e.g. __tests__/helpers/test-identities.ts). Tests only. The jest
    // setup file loads the app's modules inside jest.isolateModules, which takes a callback and
    // so can only load through require (jest.setup.ts, ADR-054).
    files: ["**/__tests__/**/*.ts", "**/*.test.ts", "jest.setup.ts"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // TASK-198 D-19: `expect(xs.every(…)).toBe(true)` passes on an empty list — every test asserts
    // the list is non-empty first (eslint-rules/every-needs-nonempty.cjs).
    files: [
      "**/__tests__/**/*.ts",
      "**/__tests__/**/*.tsx",
      "**/*.test.ts",
      "**/*.test.tsx",
      "e2e/**/*.ts",
      "e2e-live/**/*.ts",
    ],
    plugins: { "pf-tests": { rules: { "every-needs-nonempty": everyNeedsNonempty } } },
    rules: { "pf-tests/every-needs-nonempty": "error" },
  },
  // ADR-054 D3 — import/no-restricted-paths, one zone per product module: the core may import
  // no module; a module may import the core, itself and the modules it declares in dependsOn.
  // The rule resolves `@/` aliases and relative paths (the TypeScript resolver), and checks
  // `import`, `export … from`, dynamic `import()` and `require()` (__tests__/module-lint.test.ts
  // proves each). The composition roots — platform/modules/app-modules.ts (the app's module
  // list) and platform/modules/app-home.tsx (the app's home UI) — are the only core files
  // exempt: composing the app from its modules is what they are for, and both are consumer
  // seams the sync excludes.
  ...lintBoundaryConfigs().map((config) => ({
    ...config,
    plugins: { import: importPlugin },
  })),
];

export default eslintConfig;
