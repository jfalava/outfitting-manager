import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

const shellInstaller = fileURLToPath(new URL("../../docs/public/install.sh", import.meta.url));
const powershellInstaller = fileURLToPath(
  new URL("../../docs/public/install.ps1", import.meta.url),
);
const roots: string[] = [];
const linuxArchive = "outfitting-manager-linux-x64.zip";
const windowsArchive = "outfitting-manager-windows-x64.zip";

function tool(name: string) {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .flatMap((directory) => [join(directory, name), join(directory, `${name}.exe`)])
    .find((candidate) => existsSync(candidate));
}

const sh = tool("sh");
const zip = tool("zip");
const pwsh = tool("pwsh");
const shellTools = ["jq", "unzip", "cp", "rm", "mktemp", "mkdir", "chmod", "mv", "awk", "grep"];
const hashTool = tool("sha256sum") ? "sha256sum" : "shasum";
const canRunShell =
  process.platform !== "win32" && sh && zip && [...shellTools, hashTool].every(tool);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function isolatedRoot() {
  const root = await mkdtemp(join(tmpdir(), "outfitting-installers-test-"));
  roots.push(root);
  return root;
}

function release(tag: string, archive: string, names = [archive, `${archive}.sha256`]) {
  // Deliberately reordered keys and nested metadata: JSON layout must not affect selection.
  return {
    assets: names.map((name) => ({
      browser_download_url: `https://downloads.test/${tag}/${name}`,
      name,
    })),
    body: 'Release notes mention "tag_name" and "assets".',
    prerelease: false,
    tag_name: tag,
    draft: false,
  };
}

type Release = ReturnType<typeof release>;

async function shellFixture(releases: Release[], selectedTag = "cli-v1.0.0", badChecksum = false) {
  const root = await isolatedRoot();
  const bin = join(root, "bin");
  const home = join(root, "home");
  const temporary = join(root, "tmp");
  const downloads = join(root, "downloads", selectedTag);
  await Promise.all(
    [bin, temporary, downloads, join(home, ".local/bin")].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  await Promise.all([...shellTools, hashTool].map((name) => symlink(tool(name)!, join(bin, name))));
  await writeFile(join(root, "releases.json"), JSON.stringify(releases));
  await writeFile(join(root, "requests"), "");
  const existingBinary = join(home, ".local/bin/outfitting-manager");
  await writeFile(existingBinary, "existing binary\n");
  const content = `binary from ${selectedTag}\n`;
  await writeFile(join(downloads, "outfitting-manager"), content);
  const archivePath = join(downloads, linuxArchive);
  const zipped = spawnSync(zip!, ["-q", archivePath, "outfitting-manager"], { cwd: downloads });
  expect(zipped.status).toBe(0);
  const hash = createHash("sha256")
    .update(await readFile(archivePath))
    .digest("hex");
  await writeFile(
    `${archivePath}.sha256`,
    `${badChecksum ? "0".repeat(64) : hash}  ${linuxArchive}\n`,
  );
  await writeFile(
    join(bin, "uname"),
    `#!${sh}\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; *) exit 1;; esac\n`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "curl"),
    `#!${sh}
set -eu
url= output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    https://*) url=$1; shift;;
    --output) output=$2; shift 2;;
    *) shift;;
  esac
done
printf '%s\\n' "$url" >> "$FIXTURE_ROOT/requests"
case "$url" in
  'https://api.github.com/repos/jfalava/outfitting-manager/releases?per_page=30')
    cp "$FIXTURE_ROOT/releases.json" "$output";;
  https://github.com/jfalava/outfitting-manager/releases/download/*)
    relative=\${url#https://github.com/jfalava/outfitting-manager/releases/download/}
    cp "$FIXTURE_ROOT/downloads/$relative" "$output";;
  *) echo "Unexpected URL: $url" >&2; exit 1;;
esac
`,
    { mode: 0o755 },
  );
  return {
    root,
    bin,
    home,
    temporary,
    existingBinary,
    content,
    run: () =>
      spawnSync(sh!, [shellInstaller], {
        env: { PATH: bin, HOME: home, TMPDIR: temporary, FIXTURE_ROOT: root },
        encoding: "utf8",
        timeout: 10000,
      }),
  };
}

describe.skipIf(!canRunShell)(
  "shell installer (real script, isolated commands and downloads)",
  () => {
    test("installs verified content from compact, reordered JSON and ignores nonstable releases", async () => {
      const selected = "cli-v1.0.0";
      const fixture = await shellFixture(
        [
          { ...release("cli-v99.0.0", linuxArchive), draft: true },
          release(selected, linuxArchive),
          { ...release("cli-v98.0.0", linuxArchive), prerelease: true },
          release("cli-v100.0.0-beta.1", linuxArchive),
          release("v101.0.0", linuxArchive),
        ],
        selected,
      );
      const result = fixture.run();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Installed outfitting-manager 1.0.0");
      expect(await readFile(fixture.existingBinary, "utf8")).toBe(fixture.content);
      expect((await readFile(join(fixture.root, "requests"), "utf8")).trim().split("\n")).toEqual([
        "https://api.github.com/repos/jfalava/outfitting-manager/releases?per_page=30",
        `https://github.com/jfalava/outfitting-manager/releases/download/${selected}/${linuxArchive}`,
        `https://github.com/jfalava/outfitting-manager/releases/download/${selected}/${linuxArchive}.sha256`,
      ]);
      expect(await readdir(fixture.temporary)).toEqual([]);
      expect(await readdir(join(fixture.home, ".local/bin"))).toEqual(["outfitting-manager"]);
    });

    test.each([
      ["cli-v2.0.0", "cli-v10.0.0"],
      ["cli-v1.9.0", "cli-v1.10.0"],
      ["cli-v1.0.9", "cli-v1.0.10"],
    ])("orders %s before %s numerically regardless of API order", async (older, newer) => {
      const fixture = await shellFixture(
        [release(newer, linuxArchive), release(older, linuxArchive)],
        newer,
      );
      const result = fixture.run();
      expect(result.status, result.stderr).toBe(0);
      expect(await readFile(fixture.existingBinary, "utf8")).toBe(fixture.content);
    });

    test.each([linuxArchive, `${linuxArchive}.sha256`])(
      "fails on newest release missing %s instead of falling back",
      async (missing) => {
        const fixture = await shellFixture([
          release("cli-v1.0.0", linuxArchive),
          release(
            "cli-v2.0.0",
            linuxArchive,
            [linuxArchive, `${linuxArchive}.sha256`].filter((name) => name !== missing),
          ),
        ]);
        const result = fixture.run();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(`Release cli-v2.0.0 is missing ${missing}.`);
        expect(
          (await readFile(join(fixture.root, "requests"), "utf8")).trim().split("\n"),
        ).toHaveLength(1);
        expect(await readFile(fixture.existingBinary, "utf8")).toBe("existing binary\n");
        expect(await readdir(fixture.temporary)).toEqual([]);
      },
    );

    test("bad checksum leaves the existing binary intact and cleans temporary files", async () => {
      const fixture = await shellFixture([release("cli-v1.0.0", linuxArchive)], "cli-v1.0.0", true);
      const result = fixture.run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("SHA-256 verification failed");
      expect(await readFile(fixture.existingBinary, "utf8")).toBe("existing binary\n");
      expect(await readdir(fixture.temporary)).toEqual([]);
      expect(await readdir(join(fixture.home, ".local/bin"))).toEqual(["outfitting-manager"]);
    });

    test("requires jq before any network request", async () => {
      const fixture = await shellFixture([release("cli-v1.0.0", linuxArchive)]);
      await rm(join(fixture.bin, "jq"));
      const result = fixture.run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("jq is required.");
      expect(await readFile(join(fixture.root, "requests"), "utf8")).toBe("");
    });

    test("reports when no stable CLI release exists", async () => {
      const fixture = await shellFixture([{ ...release("cli-v1.0.0", linuxArchive), draft: true }]);
      const result = fixture.run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("No stable CLI release was found.");
    });
  },
);

// Execute the actual selection statements via the PowerShell AST. This avoids the
// Windows/x64 guard and persistent user PATH writes on non-Windows test hosts.
const powershellSelection = `
$ErrorActionPreference = 'Stop'
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:INSTALLER, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$statements = $ast.EndBlock.Statements
$start = $statements | Where-Object { $_ -is [System.Management.Automation.Language.AssignmentStatementAst] -and $_.Left.VariablePath.UserPath -eq 'repository' } | Select-Object -First 1
$end = $statements | Where-Object { $_ -is [System.Management.Automation.Language.AssignmentStatementAst] -and $_.Left.VariablePath.UserPath -eq 'temporaryDirectory' } | Select-Object -First 1
if (-not $start -or -not $end) { throw 'Selection boundaries not found' }
function Invoke-RestMethod { param($Uri, $Headers); Get-Content -LiteralPath $env:RELEASES -Raw | ConvertFrom-Json }
$selection = $ast.Extent.Text.Substring($start.Extent.StartOffset, $end.Extent.StartOffset - $start.Extent.StartOffset)
. ([scriptblock]::Create($selection))
@{ tag = $release.tag_name; archive = $archiveAsset.browser_download_url; checksum = $checksumAsset.browser_download_url } | ConvertTo-Json -Compress
`;

async function selectPowershell(releases: Release[]) {
  const root = await isolatedRoot();
  const releasesPath = join(root, "releases.json");
  await writeFile(releasesPath, JSON.stringify(releases));
  return spawnSync(
    pwsh!,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", powershellSelection],
    {
      env: {
        ...process.env,
        INSTALLER: powershellInstaller,
        RELEASES: releasesPath,
        HOME: root,
        TMPDIR: root,
      },
      encoding: "utf8",
      timeout: 20000,
    },
  );
}

describe.skipIf(!pwsh)("PowerShell installer selection and parsing", () => {
  test.each([
    ["cli-v2.0.0", "cli-v10.0.0"],
    ["cli-v1.9.0", "cli-v1.10.0"],
    ["cli-v1.0.9", "cli-v1.0.10"],
  ])(
    "selects %s before %s numerically and resolves matching assets",
    async (older, newer) => {
      const result = await selectPowershell([
        release(newer, windowsArchive),
        release(older, windowsArchive),
        { ...release("cli-v99.0.0", windowsArchive), draft: true },
        { ...release("cli-v98.0.0", windowsArchive), prerelease: true },
        release("cli-v100.0.0-rc.1", windowsArchive),
        release("v101.0.0", windowsArchive),
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        tag: newer,
        archive: `https://downloads.test/${newer}/${windowsArchive}`,
        checksum: `https://downloads.test/${newer}/${windowsArchive}.sha256`,
      });
    },
    30000,
  );

  test.each([windowsArchive, `${windowsArchive}.sha256`])(
    "fails on newest release missing %s instead of falling back",
    async (missing) => {
      const result = await selectPowershell([
        release("cli-v1.0.0", windowsArchive),
        release(
          "cli-v2.0.0",
          windowsArchive,
          [windowsArchive, `${windowsArchive}.sha256`].filter((name) => name !== missing),
        ),
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`Release cli-v2.0.0 is missing ${missing}.`);
    },
    30000,
  );

  test("reports when no stable CLI release exists", async () => {
    const result = await selectPowershell([]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("No stable CLI release was found.");
  }, 30000);
});
