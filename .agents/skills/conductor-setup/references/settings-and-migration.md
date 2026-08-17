# Settings and Migration

## Settings layers

Use the narrowest applicable layer:

1. `~/.conductor/settings.managed.toml`: organization-controlled, highest precedence.
2. `<repo>/.conductor/settings.local.toml`: gitignored machine-local repository overrides.
3. `<repo>/.conductor/settings.toml`: committed team defaults; merge to the default branch for teammates.
4. `~/.conductor/settings.toml`: this user's defaults across repositories.
5. Built-in defaults.

Any TOML settings file outranks a legacy JSON file. Keep user-only model, reasoning, approval, executable-path, and workspace-location preferences out of repository settings.

Schema URLs:

- User: `https://conductor.build/schemas/settings.schema.json`
- Repository and repository-local: `https://conductor.build/schemas/settings.repo.schema.json`
- Managed: `https://conductor.build/schemas/settings.toml.json`

## Repository settings

```toml
"$schema" = "https://conductor.build/schemas/settings.repo.schema.json"

[scripts]
setup = "pnpm install"
run_mode = "concurrent"

[scripts.run.dev]
command = "pnpm dev --port $CONDUCTOR_PORT"
default = true
icon = "play"
available_in = [ "local" ]
```

Common repository fields:

- `scripts.setup`, `scripts.archive`, `scripts.run_mode`, and `scripts.run.<id>`.
- `file_include_globs` for Files to copy when `.worktreeinclude` is absent.
- `environment_variables`, plus `.local` and `.cloud` tables.
- `prompts.*` for repository action prompts.
- `git.*` for supported archive, push/upstream, and branch-prefix behavior.
- `spotlight_testing` for local root-checkout execution.
- `enterprise_data_privacy` when repository policy requires it.

Use the repository schema rather than guessing fields. Do not commit secrets or machine-specific credentials.

## Migrate `conductor.json`

The Mac client ignores repo-level `conductor.json` once `.conductor/settings.toml` exists. Cloud setup falls back to the legacy setup script only when no settings TOML defines one, so delete the JSON after a complete migration.

Map fields as follows:

- `scripts.setup` -> `scripts.setup`
- `scripts.run` -> `scripts.run.<id>.command`
- `scripts.archive` -> `scripts.archive`
- `runScriptMode` -> `scripts.run_mode`
- `enterpriseDataPrivacy` -> `enterprise_data_privacy`

Create the TOML, migrate every supported field, validate it, and delete `conductor.json` unless the user explicitly needs a legacy workflow.

Docs:

- https://conductor.build/docs/reference/settings
- https://conductor.build/docs/reference/conductor-json
- https://conductor.build/docs/reference/settings/managed
