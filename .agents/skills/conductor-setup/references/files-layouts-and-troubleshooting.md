# Files, Layouts, and Troubleshooting

## Files to copy

Use Files to copy for static gitignored files needed by every new local workspace. Resolution order:

1. repository-root `.worktreeinclude`;
2. `file_include_globs` in repository settings;
3. the default `.env*` pattern.

An explicit `.worktreeinclude` or `file_include_globs` replaces the default, so include `.env*` when it should remain. A file is copied only when it is gitignored and matches the selected patterns. Tracked files already come from Git; generated files or anything requiring commands belongs in `scripts.setup`.

```toml
"$schema" = "https://conductor.build/schemas/settings.repo.schema.json"

file_include_globs = """
.env*
config/local.json
certs/local/**
"""
```

## Repository layouts

- For monorepos, use Conductor's working-directory selection rather than hard-coded package paths. Initialize submodules in setup when required.
- For related repositories, use `/add-dir` or per-repository run scripts rather than developer-specific sibling paths.
- Start several services in one foreground process group or expose separate run scripts for linked repositories.

## MCP, privacy, and secrets

Project `.mcp.json` files are inherited by Conductor agents and may send data to external services. Change MCP or `enterprise_data_privacy` only when requested or required by repository policy.

Keep provider credentials and machine-local secrets out of committed repository settings. Use repository-local settings, environment configuration, or gitignored copied files as appropriate.

## Troubleshooting order

- Setup failure: inspect `.conductor/setup.log`, shell assumptions, missing ignored files, root-only dependencies, absolute paths, and authentication.
- Run failure: inspect fixed ports, shared services, backgrounded processes, and commands that require the root checkout. Choose workspace-specific resources, `nonconcurrent`, or local Spotlight based on the cause.
- Settings issue: check managed and local overrides, whether shared settings reached the default branch, `.worktreeinclude` precedence, and whether TOML causes legacy JSON to be ignored.
- Archive failure: keep cleanup scoped to external resources and local shared caches; failed archive commands can block archiving.

Docs:

- https://conductor.build/docs/reference/files-to-copy
- https://conductor.build/docs/reference/worktreeinclude
- https://conductor.build/docs/guides/repositories/monorepos
- https://conductor.build/docs/guides/repositories/linking-multiple-directories
- https://conductor.build/docs/reference/mcp
- https://conductor.build/docs/troubleshooting/issues
