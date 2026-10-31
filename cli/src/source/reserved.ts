const RESERVED_SOURCE_FILES = new Set([
  "config.toml",
  "outfitting.json",
  "windows.lock.json",
  ".outfitting-source.json",
]);

export function isReservedSourcePath(path: string): boolean {
  return RESERVED_SOURCE_FILES.has(path);
}
