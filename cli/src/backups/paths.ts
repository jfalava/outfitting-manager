import { posix } from "node:path";

const windowsNames = ["APPDATA", "USERPROFILE", "LOCALAPPDATA"] as const;
const bindingName = /^[A-Z][A-Z0-9_]*$/;

export function builtinPathNames(platform: "macos" | "windows"): ReadonlyArray<string> {
  return platform === "windows" ? ["HOME", ...windowsNames] : ["HOME"];
}

export function substituteBackupPaths(
  text: string,
  bindings: Readonly<Record<string, string>>,
): string {
  const result = text.replace(/\$\{([^}]*)\}/g, (_match, key: string) => {
    if (!bindingName.test(key) || !Object.hasOwn(bindings, key)) {
      throw new Error(
        `Unsupported backup substitution: ${key}. Declare custom paths in backups.profiles.<name>.paths.`,
      );
    }
    return bindings[key]!;
  });
  if (result.includes("${")) {
    throw new Error(`Malformed backup substitution: ${text}. Use \${NAME}.`);
  }
  return result;
}

export function validateBackupBindings(
  paths: Readonly<Record<string, string>>,
  platform: "macos" | "windows",
): void {
  const builtins = Object.fromEntries(builtinPathNames(platform).map((name) => [name, "/"]));
  for (const [name, value] of Object.entries(paths)) {
    if (!bindingName.test(name) || ["HOME", ...windowsNames].includes(name)) {
      throw new Error(`Invalid or reserved backup path binding: ${name}.`);
    }
    if (value.trim().length === 0 || value.includes("\0")) {
      throw new Error(`Backup path binding ${name} must not be empty or contain NUL.`);
    }
    // Bindings expand builtins only, never other custom bindings or ambient environment variables.
    substituteBackupPaths(value, builtins);
  }
}

export function requireAbsoluteBackupPath(value: string, platform: "macos" | "windows"): string {
  const absolute =
    platform === "windows"
      ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/.?][^\\/]*[\\/][^\\/]+(?:[\\/]|$))/.test(value)
      : posix.isAbsolute(value);
  if (!absolute || value.includes("\0")) {
    throw new Error(`Backup path must be fully qualified and absolute for ${platform}: ${value}.`);
  }
  return value;
}

export function resolveBackupBindings(
  paths: Readonly<Record<string, string>> | undefined,
  builtins: Readonly<Record<string, string>>,
  platform: "macos" | "windows",
) {
  return {
    ...builtins,
    ...Object.fromEntries(
      Object.entries(paths ?? {}).map(([name, value]) => [
        name,
        requireAbsoluteBackupPath(substituteBackupPaths(value, builtins), platform),
      ]),
    ),
  };
}
