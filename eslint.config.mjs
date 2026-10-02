import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored by the shadcn / assistant-ui registry (`npx shadcn add`). Edited
    // upstream, overwritten on re-add, so linting them only reports other
    // people's style. Our own components live outside these two directories.
    "src/components/assistant-ui/**",
    "src/components/ui/**",
  ]),
]);

export default eslintConfig;
