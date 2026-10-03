import tseslint from "typescript-eslint";
import { noUiLiterals } from "./scripts/eslint-i18n.mjs";
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "artifacts/**",
      ".local/**",
      "05_ROOM_PROTOCOL.ts",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    ignores: [
      "apps/web/src/i18n/es.ts",
      "apps/web/src/i18n/pl.ts",
      "apps/web/src/i18n/en.ts",
    ],
    plugins: { i18n: { rules: { "no-ui-literals": noUiLiterals } } },
    rules: { "i18n/no-ui-literals": "error" },
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
