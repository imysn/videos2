import tseslint from "typescript-eslint";
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
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
