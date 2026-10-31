import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "run/**", "node_modules/**", "coverage/**", "playwright-report/**", "test-results/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-control-regex": "off",
    },
  },
  // Globals per runtime (TypeScript files are also split by tsconfig.server.json / tsconfig.web.json).
  {
    ignores: ["src/server/**", "src/shared/**", "src/web/**"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  { files: ["src/server/**"], languageOptions: { globals: globals.node } },
  { files: ["src/shared/**"], languageOptions: { globals: globals["shared-node-browser"] } },
  { files: ["src/web/**"], ignores: ["src/web/**/*.test.{ts,tsx}"], languageOptions: { globals: globals.browser } },
  { files: ["src/web/**/*.test.{ts,tsx}"], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  {
    files: ["src/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
);
