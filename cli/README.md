# Outfitting manager CLI

Portable local maintenance CLI for Outfitting.

See the [CLI command reference](https://outfitting.jfa.dev/docs/cli/) for all commands, options, and subcommands.

## Private fonts

Archive operations require `[fonts].bucket` in local `config.toml` or an `OUTFITTING_PRIVATE_FONTS_BUCKET` override. They do not read deployment JSON or use an implicit bucket. Select the existing bucket explicitly when upgrading; the wizard preserves this setting. Plain `fonts list` needs only the sync configuration.

`OUTFITTING_S3_ENDPOINT`, `OUTFITTING_S3_ACCESS_KEY`, and `OUTFITTING_S3_SECRET_KEY` override native font credentials on all hosts. Set both keys together; partial or blank key pairs fail without reading native credentials. Existing `outfitting-fonts` native entries remain unchanged. Amp orbs require all three environment variables. Archive commands display the bucket and inventory API before accessing the archive; review that pair before writes. See the [fonts reference](https://outfitting.jfa.dev/docs/cli/fonts/) for the archive, checksum, metadata, and inventory contract.

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

Local `[backups.credentials]` is mandatory with exactly these four logical keys. Service names have no defaults and must be distinct, nonblank, and control-free; Windows names must also be distinct ignoring case. Accepted strings preserve exact spelling. Config stores names only, while values remain in Keychain or Credential Manager under the scheduled OS user's account.

Optional `backups.credentials` in `outfitting.json` declares the same four service names. Explicit manifest import copies that mapping into local config when importing backup profiles for the current platform, replacing any previous mapping. Omission preserves existing local names; another platform's backups cannot replace them. Runtime continues to read local config. `nix switch` and source refresh never re-import the manifest or rewrite local settings.

Configure `backups.alertUrl` with a canonical HTTPS `/v1/alerts` URL, or explicitly set `alertsDisabled = true` with `alertUrl` omitted. URL credentials, queries, fragments, aliases, and trailing slashes are rejected. Opt-out skips alert-token lookup, including `secrets check`, which checks only the three repository credentials; the four-key mapping remains required. Canary's credential policy owns the sender and complete recipient list. The CLI sends only `title`, `message`, `timestamp`, and `metadata`, authenticated with the native `alert-token` as a bearer token. HTTP 202 confirms provider acceptance, not inbox delivery. There is no personal host/platform allowlist or legacy endpoint/payload fallback. Backup commands refuse a missing alert choice before native access.

When upgrading from slug routes, change the URL path to exactly `/v1/alerts` and remove `alertSender` and `alertRecipient` from local TOML before running the CLI or wizard; obsolete keys are rejected. Refresh the validated remote source cache with `outfitting-manager init` after changing the endpoint. Coordinate with Canary's deployment: an operator must manually create `credentials/<lowercase SHA-256 digest>` in its live KV, hashing the exact raw token without trimming or a newline, and configure the sender and all recipients there. Existing native tokens can stay if they meet Canary's 32–512 printable-ASCII limit and have a matching enabled policy; otherwise rotate privately. KV propagation can take 60 seconds or more. No caller inventory, per-caller binding, manifest, or provisioning automation is needed. See [alert setup](https://outfitting.jfa.dev/docs/backups/setup/#configure-alerts-or-explicitly-disable-them) for the cutover and protocol details.

Files are ordered, repository-relative TOML fragments. Tables merge recursively, later scalars override, snapshots append (duplicate names fail), and other arrays replace. `init` includes the platform's backup fragments in its validated sparse source; changing their order invalidates the offline declaration hash. Commands read the local configured source or validated offline sparse source, never another checkout. `--profile NAME` selects one backup profile; commands never run all declared profiles.

Rustic sources and globs can reference `${DOCUMENTS}` and `${PHOTOS}` from the selected profile's `paths`. `${HOME}` is built in; Windows also provides `${APPDATA}`, `${USERPROFILE}`, and `${LOCALAPPDATA}`. Custom values may reference builtins only; names cannot override builtins. Unknown, empty, malformed, or non-absolute source bindings fail before Rustic. No Proton paths or localized folder names are inferred. Existing Proton placeholders require explicit bindings preserving their exact previous paths. Binding changes invalidate the remote source cache, but never change receipt/lock locations or the repository identity hash.

Rustic writes `rustic.log` in the configured log directory. Newly generated macOS schedules use that directory for wrapper stdout/stderr too; create it before loading the LaunchAgent. Schedule generation is print-only and does not change installed schedules. Log-only changes do not invalidate the source cache.

New macOS schedules use label `dev.outfitting.backups.<selected-profile>`. Optional local `backups.scheduleLabel` overrides it and must match `[A-Za-z0-9][A-Za-z0-9._-]{0,254}`. Generation never installs or relabels live schedules. Windows task naming remains the registration caller's responsibility. Credentials, `scheduleLabel`, and `alertsDisabled` are excluded from the source hash; the alert endpoint remains part of the hash.

Each snapshot is one job: names must be unique, and tags must include the job name and no other job name. Unknown configuration keys and substitutions fail closed. Supported repository options are `bucket`, `endpoint`, `region`, and `root`; credentials belong only in the native secret store. A rustic `[global]` table is rejected: logging and failure alerts are manager-owned, and arbitrary hooks are never executed.

Commands: `doctor`, `status`, `run`, `run-due`, `snapshots`, `check [--read-data]`, `restore JOB FULL_ID NEW_DIRECTORY`, `accept JOB FULL_ID`, `maintenance [--apply] [--acknowledge-history]`, `secrets set|check`, and `schedule --binary ABSOLUTE_PATH`. Use `--help` for options. `doctor` reports configuration, not verified source access. `status` reads receipts without repository access. `schedule` prints XML only; set `BACKUP_RUSTIC` to an absolute executable path first. Save Windows task XML as UTF-16 to match its declaration.

### Cutover requires native-host verification

The port preserves the donor's repository-serialization hash, receipt directory, hostname rules, and repository lock. Identity cleanup does not change backup sources. Explicit service-name mappings can preserve existing native identities without renaming credentials, and `backups.scheduleLabel` can keep an existing LaunchAgent label. `doctor` shows resolved service names, schedule label, and alert configuration without secret values. Keep the existing receipts; do not initialize or recreate remote repositories. `run` and `run-due` never run retention. Maintenance previews every job, protects two accepted anchors, and checks before applying explicit deletion and two-phase prune. Shrinkage greater than 50% requires accepting the exact reviewed candidate. A running process listed in a job's `skipIfProcessesRunning` skips only that job and preserves retry eligibility; failed process probes fail closed.

Keep a matched previous binary, config, and validated source cache for rollback. Removing alert fields does not restore a legacy default in the new binary. Native credential approval and any live config, credential, or schedule changes remain manual; installing the CLI does not deploy an alert service.

Before replacing a schedule, compare `doctor` and `status` against the donor and verify native credentials and source access using the actual scheduled binary/user. Verify a disposable backup and restore on each native platform. Stop/replace the legacy schedule only when no run is active; do not install a second writer or pruner. Windows requires an interactive logged-in user (locked is supported, logged-off is not). Generated tasks retain `IgnoreNew` and no execution timeout. Do not delete a stale lock until the prior process is confirmed stopped.

No schedule installation, credential migration, production backup, retention, or production restore is performed by the configuration wizard. Tests use mocks and disposable directories. To enable disposable Rustic integration tests, set `OUTFITTING_TEST_RUSTIC` to an absolute executable path when running `bun run test -- test/backup-safety.test.ts` from `cli/`; Windows-specific integration requires Windows.
