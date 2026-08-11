import globals from "globals";

export default [
  {
    ignores: [
      ".audit/**",
      "asset/**",
      "dist/**",
      "node_modules/**",
    ],
  },
  {
    files: ["src/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.worker,
        __OFFLINE_MODE__: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-redeclare": "error",
      "no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        caughtErrors: "none",
      }],
    },
  },
  {
    files: [
      "scripts/**/*.mjs",
      "tests/**/*.mjs",
      "vite.config.mjs",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      "no-undef": "error",
      "no-redeclare": "error",
      "no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        caughtErrors: "none",
      }],
    },
  },
  {
    files: ["check-upgrade-plan.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: globals.node,
    },
    rules: {
      "no-undef": "error",
      "no-redeclare": "error",
      "no-unused-vars": "error",
    },
  },
];
