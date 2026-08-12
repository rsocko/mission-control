import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import reactHooks from "eslint-plugin-react-hooks";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Next.js 16's react-hooks plugin includes React Compiler rules that flag
  // patterns the compiler cannot auto-optimize. These are valid React code —
  // downgrade to warnings so builds aren't blocked while still surfacing
  // optimization opportunities for developers.
  {
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/use-memo": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Archived documentation — not part of the active build
    "docs/**",
    // One-off migration scripts
    "scripts/**",
    // Docs screenshot suite — uses separate Playwright config, not part of main build
    "tests/docs/**",
    "playwright.docs.config.ts",
  ]),
]);

export default eslintConfig;
