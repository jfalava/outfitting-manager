import { expect, test } from "vitest";

import { ui } from "@/ui";

test("status lines use an indented icon and indent multiline details", () => {
  const output = ui.warning("Warning: apt could not refresh\r\nSome index files were ignored.\r\n");

  expect(output).toMatch(
    /^  \S+ Warning: apt could not refresh\n    Some index files were ignored\.$/,
  );
  expect(output).not.toContain("\r");
});
