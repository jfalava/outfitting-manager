# Outfitting manager CLI

Portable local maintenance CLI for Outfitting.

See the [CLI command reference](https://outfitting.jfa.dev/docs/cli/) for all commands, options, and subcommands.

## Rustic backups (macOS and Windows)

Backup profiles are independent of package/system profiles. Import a schema-2 repo manifest explicitly:

```sh
outfitting-manager config wizard --manifest system/macos/outfitting.json
outfitting-manager init
outfitting-manager backups doctor
```

Use `system/windows/outfitting.json` on Windows. Editing the manifest alone does not change local configuration. Re-import replaces the current platform's backup declarations and preserves other platforms. Runtime configuration keeps schema 1:

```toml
[backups]
profile = "ultramar"

[backups.profiles.ultramar]
platform = "macos"
files = ["backups/common/common.toml", "backups/macos/ultramar.toml"]
```

Files are ordered, repository-relative TOML fragments. Tables merge recursively, later scalars override, snapshots append (duplicate names fail), and other arrays replace. `init` includes the platform's backup fragments in its validated sparse source; changing their order invalidates the offline declaration hash. Commands read the local configured source or validated offline sparse source, never the donor checkout. `--profile NAME` selects one backup profile; commands never run all declared profiles.

The initial port supports the donor jobs: macOS `documents`/`images`, and Windows `ffxiv-mods`/`ffxiv-configs`/`mmo-screenshots`. Each platform profile must declare its jobs once with their existing tags. Unknown configuration keys and substitutions fail closed. Supported repository options are `bucket`, `endpoint`, `region`, and `root`; credentials belong only in the native secret store. Legacy global logging and failure-hook declarations are accepted for migration but replaced by manager-owned logging and alerts; arbitrary hooks are never executed.

Commands: `doctor`, `status`, `run`, `run-due`, `snapshots`, `check [--read-data]`, `restore JOB FULL_ID NEW_DIRECTORY`, `accept JOB FULL_ID`, `maintenance [--apply] [--acknowledge-history]`, `secrets set|check|import-secretstore`, and `schedule --binary ABSOLUTE_PATH`. Use `--help` for options. `doctor` reports configuration, not verified source access. `status` reads receipts without repository access. `schedule` prints XML only; set `BACKUP_RUSTIC` to an absolute executable path first. Save Windows task XML as UTF-16 to match its declaration.

### Cutover requires native-host verification

The port preserves the donor's repository-serialization hash, receipt directory, hostname rules, native secret identities, alerts, and repository lock. Keep the existing receipts; do not initialize or recreate remote repositories. `run` and `run-due` never run retention. Maintenance previews every job, protects two accepted anchors, and checks before applying explicit deletion and two-phase prune. Shrinkage greater than 50% requires accepting the exact reviewed candidate. FFXIV running skips only its configuration job and preserves retry eligibility; failed process probes fail closed.

Before replacing a schedule, compare `doctor` and `status` against the donor and verify native credentials and source access using the actual scheduled binary/user. Verify a disposable backup and restore on each native platform. Stop/replace the legacy schedule only when no run is active; do not install a second writer or pruner. Windows requires an interactive logged-in user (locked is supported, logged-off is not). Generated tasks retain `IgnoreNew` and no execution timeout. Do not delete a stale lock until the prior process is confirmed stopped.

No schedule installation, credential migration, production backup, retention, or production restore is performed by the configuration wizard. Tests use mocks and disposable directories. To enable disposable Rustic integration tests, set `OUTFITTING_TEST_RUSTIC` to an absolute executable path when running `bun run test -- test/backup-safety.test.ts` from `cli/`; Windows-specific integration requires Windows.
