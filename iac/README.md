# Outfitting Manager IaC

Alchemy stack for the manager API, docs site, shared router, lockfile KV/D1 storage, private-font R2
bucket, and API token binding. Platform installer Workers and their hostnames are deployed from
`jfalava/machines`.

## Configuration

Precedence is **CLI flags → environment → deployment JSON → defaults**. Select a file with
`outfitting-manager provision --deploy-config PATH` or `OUTFITTING_DEPLOY_CONFIG`; otherwise,
`outfitting.deploy.json` is discovered in the current directory. An explicitly selected missing file
is an error. Start from `iac/outfitting.deploy.example.json` to configure your own deployment.

Generic provisioning has no custom hostname and uses the router's `workers.dev` URL unless a domain
is configured. Set `domain` in deployment JSON, `OUTFITTING_DOMAIN`, or `--domain`. An empty
`OUTFITTING_DOMAIN` or `--domain ""` clears the resolved hostname and enables the Worker URL. This
does not detach an existing custom domain: Alchemy leaves domain attachments alone when the stack
omits `domain`. The API remains under `/api`.

| Setting             | Default                     |
| ------------------- | --------------------------- |
| Stack               | `OutfittingManager`         |
| Router              | `outfitting-manager-router` |
| API                 | `outfitting-api`            |
| KV and D1           | `outfitting-lockfiles`      |
| Private-font bucket | `outfitting-private-fonts`  |
| API/docs hostname   | None; router Worker URL     |

The router strips `/api` and forwards API requests, then sends allowlisted docs paths to the docs
Worker. The private-font bucket is owned by this stack; the installer Worker in `jfalava/machines`
binds to that bucket by physical name.

## Commands

- `bun run ci:build` typechecks the stack.
- `bun run test:api` and `bun run test:router` test its request paths.
- Root `bun run deploy`, `ci:deploy`, `plan`, and `destroy` delegate to the IaC scripts, which
  explicitly select `iac/outfitting.production.deploy.json`. The production config preserves
  `outfitting.jfa.dev`; it contains no secrets. `ci:deploy` deploys non-interactively.
- Direct Alchemy commands and `outfitting-manager provision` do not automatically select the
  production config. To provision that deployment through the CLI, explicitly pass
  `--deploy-config iac/outfitting.production.deploy.json` from the repository root. For another
  deployment, select its own config instead. The `dev` script also uses generic config resolution.

The default stack and resource names are still this deployment's names. Omitting the production
config does not create an isolated deployment; against the same Cloudflare account and stage,
provisioning can adopt and update those resources. Choose distinct stack and resource names for
an independent deployment.

In this repository's production deployment, the API and docs share `outfitting.jfa.dev`; `/api` is
the API path and the root serves docs. Do not bind `api.outfitting.jfa.dev` or move installer
hostnames onto the manager router. Other deployments must explicitly configure their own hostname.
