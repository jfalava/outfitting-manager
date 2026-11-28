import { defineConfig } from "oxfmt";

import { fmtBase } from "../oxfmt.config.ts";

export default defineConfig({
  ...fmtBase,
  // .nimbus/ is written by the Nimbus build, which would undo any formatting.
  ignorePatterns: ["*.astro", "**/*.astro", "*.mdx", "*.md", ".nimbus/**"],
});
