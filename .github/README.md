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
