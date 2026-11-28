import { defineConfig, type OxfmtConfig } from "oxfmt";

// Shared formatting options for the root, docs, and workspace configs.
export const fmtBase: OxfmtConfig = {
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  endOfLine: "lf",
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  insertFinalNewline: true,
  sortImports: true,
  sortPackageJson: true,
  sortTailwindcss: true,
};

// Workspace packages also sort package.json scripts.
export const workspaceFmt: OxfmtConfig = {
  ...fmtBase,
  sortPackageJson: { sortScripts: true },
};

// Repo root only formats top-level files; each workspace formats itself with
// its own oxfmt.config.ts.
export default defineConfig({
  ...fmtBase,
  ignorePatterns: [
    "api/**",
    "cli/**",
    "contract/**",
    "docs/**",
    "iac/**",
    "router/**",
    "tools/**",
    "node_modules/**",
    "result/**",
    // machine-memory init owns the managed block in this file.
    "AGENTS.md",
  ],
});
