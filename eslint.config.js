import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: [
      "server.js",
      "src/**/*.js",
      "test/**/*.js",
      "scripts/**/*.js",
      "e2e/**/*.js",
      "playwright.config.js",
      "eslint.config.js",
    ],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_|^next$|^req$|^res$", varsIgnorePattern: "^_" },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
      eqeqeq: ["warn", "smart"],
      "no-var": "error",
      "prefer-const": "warn",
    },
  },
  {
    // app.js подключается как <script type="module">, sw.js — обычный скрипт.
    files: ["public/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.serviceworker },
    },
    rules: {
      "no-unused-vars": ["warn", { varsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-var": "error",
      "prefer-const": "warn",
    },
  },
  {
    ignores: ["node_modules/**", "data/**", "docs/**"],
  },
];
