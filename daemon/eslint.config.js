import js from "@eslint/js";
import globals from "globals";

// The daemon ships plain ESM with no build step, so this runs straight off src/, scripts/ and test/.
// `node --check` stays the first gate in CI because it needs no dependencies at all.
export default [
  {
    ignores: ["node_modules/**", "coverage/**", "public/**", "clippy/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // A protocol handler receives (ws, msg) and often reads only one; an argument that is
      // genuinely unused is renamed _x so the intent is visible, and nothing is exempt by position.
      "no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
          varsIgnorePattern: "^_",
        },
      ],
      // An empty catch is the documented shape for a probe that is allowed to fail.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // The pump loops are literal while (true); only a constant non-loop condition is a bug.
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },
];
