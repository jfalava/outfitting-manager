import { CliOutput, type Command } from "effect/cli";

/** Keep built-in help and add the parent's command list to leaf commands. */
export function makeCommandHelpLayer(root: Command.Command.Any) {
  const relatedHelp = new Map<string, string>();

  function visit(parent: Command.Command.Any, path: ReadonlyArray<string>) {
    const children = parent.subcommands.flatMap((group) => group.commands);
    const rows = children
      .filter((command) => !command.unlisted)
      .map((command) => ({
        name: [...path.slice(1), command.name].join(" "),
        description: (command.shortDescription ?? command.description ?? "")
          .replace(/\s+/g, " ")
          .trim(),
      }));
    const width = Math.max(0, ...rows.map((row) => row.name.length));
    const listing = rows
      .map((row) => `  ${row.name.padEnd(width)}    ${row.description}`)
      .join("\n");

    for (const child of children) {
      const childPath = [...path, child.name];
      if (child.subcommands.length > 0) {
        visit(child, childPath);
      } else if (listing) {
        relatedHelp.set(childPath.join(" "), `\n\nRELATED COMMANDS\n${listing}`);
      }
    }
  }

  visit(root, [root.name]);
  const base = CliOutput.defaultFormatter();
  return CliOutput.layer({
    ...base,
    formatHelpDoc: (doc) => {
      // Built-in usage starts with the canonical command path, even for aliases.
      const related = [...relatedHelp].find(
        ([path]) => doc.usage === path || doc.usage.startsWith(`${path} `),
      );
      return base.formatHelpDoc(doc) + (related?.[1] ?? "");
    },
  });
}
