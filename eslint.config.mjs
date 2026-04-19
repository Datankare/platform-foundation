import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import regexpPlugin from "eslint-plugin-regexp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  {
    ignores: ["coverage/**", ".next/**", "node_modules/**", "next-env.d.ts", "k6/**"],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript", "prettier"),
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
];

export default eslintConfig;
