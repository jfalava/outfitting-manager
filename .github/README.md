# Outfitting Manager

Outfitting is a cross-platform bootstrap and maintenance system for personal development machines.

[Read the documentation](https://outfitting.jfa.dev/)

## Install

### Windows

```powershell
irm https://outfitting.jfa.dev/install.ps1 | iex
```

### macOS and Linux

```bash
curl -fsSL https://outfitting.jfa.dev/install.sh | sh
```

## Repository

This repository is a monorepo:

- `cli/` — the `outfitting-manager` CLI, compiled with Bun for each platform.
- `contract/` — types and codecs shared by the CLI and the API.
- `api/` — the manager API Worker.
- `router/` — the edge router in front of the API and the docs.
- `docs/` — the documentation site, built with Astro and Nimbus.
- `iac/` — the Alchemy stack that deploys the Workers, the docs and their storage.

## Scripts

Every package defines the same verbs, and the root runs each one in every workspace with `bun run --workspaces`. Reach one package with `--cwd`, for example `bun run --cwd cli test`.

| Script                                              | Writes files | What it does                                                                                                                                                                                               |
| --------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run check`                                     | no           | The gate: `lint`, `format:check`, `typecheck` and `test` in every package, then `oxfmt --check` on the root's own files.                                                                                   |
| `bun run fix`                                       | yes          | `lint:fix`, then `format`.                                                                                                                                                                                 |
| `bun run lint` / `lint:fix`                         | no / yes     | `oxlint --type-aware --type-check`.                                                                                                                                                                        |
| `bun run format` / `format:check`                   | yes / no     | `oxfmt`.                                                                                                                                                                                                   |
| `bun run typecheck`                                 | no           | `effect-tsgo tsrs --noEmit`: TypeScript and Effect diagnostics in one pass, tests included. The policy is in `tsconfig.base.json`.                                                                         |
| `bun run test`                                      | no           | Each package's suite, run once, with vitest.                                                                                                                                                               |
| `bun run plan` / `deploy` / `ci:deploy` / `destroy` | no           | Alchemy from `iac/`, with `OUTFITTING_DEPLOY_CONFIG=./outfitting.production.deploy.json`. `ci:deploy` is the non-interactive deploy, with `--yes --adopt`.                                                 |
| `bun run dev`                                       | no           | `alchemy dev` from `iac/`, with generic deploy config resolution.                                                                                                                                          |
| `bun run ci:build`                                  | no           | What the Workers Builds `stable` trigger runs before `ci:deploy`: `bun run check`. The deploy builds the docs site itself.                                                                                 |
| `bun run --cwd cli build:<target>`                  | `cli/dist/`  | The release binary for one target: `darwin-arm64`, `linux-x64`, `linux-arm64`, `nixos-x64`, `nixos-arm64` or `windows-x64`. Each script picks that platform's entrypoint. `build:all` builds every target. |
| `bun run --cwd cli build`                           | `cli/dist/`  | The binary for this host: runs the `build:<target>` script for the release asset `outfitting-manager upgrade` would install here (`cli/scripts/build.ts`), so NixOS hosts get the NixOS build.             |

`bun install` runs `prepare`, which patches tsrs and oxlint with the Effect builds (`effect-tsgo patch --no-typescript --tsrs --oxlint`). Bun is pinned once, in `packageManager`, and tool versions are pinned in the root `catalogs`. Bump `@effect/tsgo`, `tsrs` and `oxlint` together: `prepare` fails the install on a tsrs or oxlint version that `@effect/tsgo` does not support.

## CI and releases

GitHub Actions runs the check, and Cloudflare Workers Builds only deploys, so no Cloudflare API token lives in GitHub secrets.

- `.github/workflows/ci.yml` runs `bun run check` on every push to any branch and on every pull request. `main` and `stable` should require its `check` job (shown as `CI / check`) to pass before merging.
- Workers Builds on the `outfitting-manager-router` Worker has one trigger, for `stable`. Its settings live in the Cloudflare dashboard, so they are recorded here. There is no trigger for other branches.

| Setting           | Production trigger                                                   |
| ----------------- | -------------------------------------------------------------------- |
| Branches          | `stable`                                                             |
| Root directory    | `/`                                                                  |
| Build command     | `bun run ci:build`: `bun run check` again, just before deploying     |
| Deploy command    | `bun run ci:deploy`, which sets `OUTFITTING_DEPLOY_CONFIG` in `iac/` |
| Build watch paths | include `*`, exclude none                                            |
| Build cache       | on                                                                   |
| Build variables   | `OUTFITTING_SYNC_TOKEN` only. Bun comes from `packageManager`.       |

Deploying is a merge from `main` into `stable`. `.github/workflows/outfitting-manager-cli-release.yml` publishes the CLI when a `cli-v<version>` tag matching `cli/package.json` is pushed: it runs `bun run check`, builds each target with `bun run --cwd cli build:<target>`, signs the macOS binary, and attaches each `outfitting-manager-<target>.zip` and its `.sha256` to a GitHub release. Dependabot keeps the SHA-pinned actions in both workflows current.

## Exceptions to the scripts standard

| Where                | Exception                                                                                                                                                                                                                                                               | Why                                                                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/`              | `typecheck` is `astro check`. `lint` is `lint:oxlint` (`astro sync`, then type-aware oxlint on `src`), `lint:astro` (ESLint) and `lint:docs` (`nimbus-docs lint`). `format` runs Prettier on `src/` as well as oxfmt. It keeps its own `typescript` 6 and has no tests. | tsrs and oxlint cannot parse `.astro` files, and `@astrojs/check` needs TypeScript 5 or 6. `astro sync` writes the generated types that type-aware oxlint reads.                |
| `docs/tsconfig.json` | Turns `noUncheckedIndexedAccess` off.                                                                                                                                                                                                                                   | The components under `docs/src/components/ui/` come from the nimbus-docs registry and are upgraded with `nimbus-docs add <slug> --overwrite`, which would undo local fixes.     |
| Root                 | `check`, `fix`, `format` and `format:check` also run oxfmt on the root's own files after the fan-out.                                                                                                                                                                   | Those files belong to no workspace.                                                                                                                                             |
| Release              | The tag is `cli-v<version>`, not `v<version>`. The matrix has two NixOS targets, signs the macOS binary in the workflow, and renames the binary to `outfitting-manager` (`.exe` on Windows) inside each archive, with one `.sha256` per archive.                        | Only `cli` releases in this monorepo. Signing needs the `MACOS_SIGNING_P12` secrets. `outfitting-manager upgrade` and the installers download those archive and checksum names. |
