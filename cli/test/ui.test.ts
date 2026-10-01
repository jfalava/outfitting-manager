import { expect, test } from "vitest";

import { ui } from "@/ui";

test("status lines use an indented icon and indent multiline details", () => {
  const output = ui.warning("Warning: apt could not refresh\r\nSome index files were ignored.\r\n");

  expect(output).toMatch(
    /^  \S+ Warning: apt could not refresh\n    Some index files were ignored\.$/,
  );
  expect(output).not.toContain("\r");
});

test("status lines keep distinct semantic icons", () => {
  const lines = [ui.info("info"), ui.note("note"), ui.warning("warning"), ui.error("error")];

  expect(new Set(lines.map((line) => Array.from(line)[2])).size).toBe(4);
});
