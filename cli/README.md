# Outfitting manager CLI

Portable local maintenance CLI for Outfitting.

See the [CLI command reference](https://outfitting.jfa.dev/docs/cli/) for all commands, options, and subcommands.

## Rustic backups (macOS and Windows)

Backup profiles are independent of package/system profiles. Import a schema-3 repo manifest explicitly:

```sh
outfitting-manager config wizard --manifest system/macos/outfitting.json
outfitting-manager init
# Import credential service names from the manifest or add them locally; configure local alerts.
outfitting-manager backups doctor
```

Use `system/windows/outfitting.json` on Windows. Editing the manifest alone does not change local configuration. Re-import replaces the current platform's backup declarations and preserves other platforms. Runtime configuration uses schema 2:

```toml
schema = 2

[backups]
profile = "personal"
# Optional machine-local override; defaults to the platform's normal log location.
logDirectory = "${HOME}/Backup Logs"
alertsDisabled = true

[backups.credentials]
access-key = "workstation-backup-access-key"
secret-key = "workstation-backup-secret-key"
repository-password = "workstation-backup-repository-password"
alert-token = "workstation-backup-alert-token"

[backups.profiles.personal]
platform = "macos"
files = ["backups/common.toml", "backups/personal.toml"]

[backups.profiles.personal.paths]
DOCUMENTS = "${HOME}/Documents"
PHOTOS = "/Volumes/Archive/Photos"
```

Local `[backups.credentials]` is mandatory with exactly these four logical keys. Service names have no defaults and must be distinct, nonblank, and control-free; Windows names must also be distinct ignoring case. Accepted strings preserve exact spelling. Config stores names only, while values remain in Keychain or Credential Manager under the scheduled OS user's account. `secrets import-secretstore` reads and writes the same configured service names and preflights destination conflicts.

Optional `backups.credentials` in `outfitting.json` declares the same four service names. Explicit manifest import copies that mapping into local config when importing backup profiles for the current platform, replacing any previous mapping. Omission preserves existing local names; another platform's backups cannot replace them. Runtime continues to read local config. `nix switch` and source refresh never re-import the manifest or rewrite local settings.

Configure `backups.alertUrl`, `alertSender`, and `alertRecipient` together, or explicitly set `alertsDisabled = true` with all three omitted. Opt-out skips alert-token lookup, including `secrets check`, which checks only the three repository credentials; the four-key mapping remains required. Enabled alerts accept a canonical HTTPS `/v1/alerts/<slug>` URL, with slug `[a-z0-9]+(?:-[a-z0-9]+)*` and no URL credentials, query, fragment, aliases, or trailing slash. The server owns authorization; there is no personal host/platform allowlist or legacy endpoint/payload fallback. See [alert setup](https://outfitting.jfa.dev/docs/backups/setup/#configure-alerts-or-explicitly-disable-them) for addressing and v1 protocol details. Backup commands refuse incomplete settings before native access; global config loading and the wizard remain usable for migration.

Files are ordered, repository-relative TOML fragments. Tables merge recursively, later scalars override, snapshots append (duplicate names fail), and other arrays replace. `init` includes the platform's backup fragments in its validated sparse source; changing their order invalidates the offline declaration hash. Commands read the local configured source or validated offline sparse source, never the donor checkout. `--profile NAME` selects one backup profile; commands never run all declared profiles.

Rustic sources and globs can reference `${DOCUMENTS}` and `${PHOTOS}` from the selected profile's `paths`. `${HOME}` is built in; Windows also provides `${APPDATA}`, `${USERPROFILE}`, and `${LOCALAPPDATA}`. Custom values may reference builtins only; names cannot override builtins. Unknown, empty, malformed, or non-absolute source bindings fail before Rustic. No Proton paths or localized folder names are inferred. Existing Proton placeholders require explicit bindings preserving their exact previous paths. Binding changes invalidate the remote source cache, but never change receipt/lock locations or the repository identity hash.

Rustic writes `rustic.log` in the configured log directory. Newly generated macOS schedules use that directory for wrapper stdout/stderr too; create it before loading the LaunchAgent. Schedule generation is print-only and does not change installed schedules. Log-only changes do not invalidate the source cache.

New macOS schedules use label `dev.outfitting.backups.<selected-profile>`. Optional local `backups.scheduleLabel` overrides it and must match `[A-Za-z0-9][A-Za-z0-9._-]{0,254}`. Generation never installs or relabels live schedules. Windows task naming remains the registration caller's responsibility. Credentials, `scheduleLabel`, and `alertsDisabled` are excluded from the source hash; existing alert addressing hash behavior is unchanged.

The initial port supports the donor jobs: macOS `documents`/`images`, and Windows `ffxiv-mods`/`ffxiv-configs`/`mmo-screenshots`. Each platform profile must declare its jobs once with their existing tags. Unknown configuration keys and substitutions fail closed. Supported repository options are `bucket`, `endpoint`, `region`, and `root`; credentials belong only in the native secret store. Legacy global logging and failure-hook declarations are accepted for migration but replaced by manager-owned logging and alerts; arbitrary hooks are never executed.

Commands: `doctor`, `status`, `run`, `run-due`, `snapshots`, `check [--read-data]`, `restore JOB FULL_ID NEW_DIRECTORY`, `accept JOB FULL_ID`, `maintenance [--apply] [--acknowledge-history]`, `secrets set|check|import-secretstore`, and `schedule --binary ABSOLUTE_PATH`. Use `--help` for options. `doctor` reports configuration, not verified source access. `status` reads receipts without repository access. `schedule` prints XML only; set `BACKUP_RUSTIC` to an absolute executable path first. Save Windows task XML as UTF-16 to match its declaration.

### Cutover requires native-host verification

The port preserves the donor's repository-serialization hash, receipt directory, hostname rules, and repository lock. Identity cleanup does not change backup sources. Explicit service-name mappings can preserve existing native identities without renaming credentials; see the [migration examples](https://outfitting.jfa.dev/docs/backups/setup/#migrate-an-existing-backup-configuration) for historical Ultramar/R2 names and the `com.jfa.rustic-backup` label override. `doctor` shows resolved service names, schedule label, and alert configuration without secret values. Keep the existing receipts; do not initialize or recreate remote repositories. `run` and `run-due` never run retention. Maintenance previews every job, protects two accepted anchors, and checks before applying explicit deletion and two-phase prune. Shrinkage greater than 50% requires accepting the exact reviewed candidate. FFXIV running skips only its configuration job and preserves retry eligibility; failed process probes fail closed.

Keep a matched previous binary, config, and validated source cache for rollback. Removing alert fields does not restore a legacy default in the new binary. Native credential approval and any live config, credential, or schedule changes remain manual; installing the CLI does not deploy an alert service.

Before replacing a schedule, compare `doctor` and `status` against the donor and verify native credentials and source access using the actual scheduled binary/user. Verify a disposable backup and restore on each native platform. Stop/replace the legacy schedule only when no run is active; do not install a second writer or pruner. Windows requires an interactive logged-in user (locked is supported, logged-off is not). Generated tasks retain `IgnoreNew` and no execution timeout. Do not delete a stale lock until the prior process is confirmed stopped.

No schedule installation, credential migration, production backup, retention, or production restore is performed by the configuration wizard. Tests use mocks and disposable directories. To enable disposable Rustic integration tests, set `OUTFITTING_TEST_RUSTIC` to an absolute executable path when running `bun run test -- test/backup-safety.test.ts` from `cli/`; Windows-specific integration requires Windows. Set `OUTFITTING_TEST_PWSH` to an absolute PowerShell 7 executable path to run the SecretStore script regression in `test/secrets.test.ts`; it stubs `Get-Secret` and never accesses a real vault.
