import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "eslint.config.mjs"]
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      complexity: ["error", 8],
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error"
    }
  },
  {
    // Terminal rendering code: character classification is flat boolean range
    // checks (high cyclomatic complexity by nature), and spreading strings is
    // the intended code-point iteration for width-safe glyph substitution.
    files: ["packages/diffusion-canvas/extensions/**"],
    rules: {
      complexity: ["error", 16],
      "@typescript-eslint/no-misused-spread": "off"
    }
  }
);
