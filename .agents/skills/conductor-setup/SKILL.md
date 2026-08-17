---
name: conductor-setup
description: Configure .conductor/settings.toml, migrate legacy conductor.json, and set up local/cloud Conductor workspace scripts, env vars, files, and caches.
metadata:
  source: "biw/skills"
  homepage: "https://github.com/biw/skills"
---

# Conductor Setup

Use this skill when configuring a repository for Conductor workspaces. When invoked directly, audit the setup against the conventions below and either apply the changes or report that none are needed.

## Workflow

1. Inspect `.conductor/settings.toml`, `.conductor/settings.local.toml`, legacy `conductor.json`, `.worktreeinclude`, `.conductor/*.sh`, legacy root-level `conductor-*.sh`, package scripts, and repo docs. Check `CONDUCTOR_IS_LOCAL` and decide whether each script supports local workspaces, cloud workspaces, or both.
2. Read only the references needed for the task:
   - `references/settings-and-migration.md` for settings layers, schemas, supported repository fields, or `conductor.json` migration.
   - `references/scripts-and-environment.md` for setup/run/archive scripts, shells, variables, concurrency, Spotlight, or caches.
   - `references/files-layouts-and-troubleshooting.md` for Files to copy, `.worktreeinclude`, monorepos, linked repositories, MCP/privacy, or diagnosis.
     Read more than one only when the task crosses those concerns.
3. Apply the selected reference's documented contract. Prefer team settings over machine-local configuration; preserve an existing deliberate script layout; use Conductor variables instead of hard-coded workspace paths, resources, and local ports.
4. Keep secrets and machine-specific credentials out of committed settings. Change MCP/privacy configuration only when asked or required by repository policy.
5. Validate TOML and run the narrowest relevant check for every script changed. Report when the existing setup already satisfies the requested outcome.

## Resources

- `references/settings-and-migration.md`: settings scope, precedence, fields, schemas, and legacy migration.
- `references/scripts-and-environment.md`: script roles, local/cloud shells and variables, run behavior, caches, and cleanup.
- `references/files-layouts-and-troubleshooting.md`: copied files, repository layouts, privacy boundaries, and diagnosis.
