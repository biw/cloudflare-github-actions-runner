# Scripts and Environment

## Runtime contract

Setup, run, and archive commands start in the workspace directory in non-interactive shells: `zsh` locally on macOS and `bash` in cloud workspaces. Put required PATH/toolchain setup in the command or script; do not rely on interactive startup files.

Conductor provides:

- `CONDUCTOR_WORKSPACE_NAME` and `CONDUCTOR_WORKSPACE_PATH` everywhere.
- `CONDUCTOR_ROOT_PATH`: local repository root; equal to the workspace path in cloud.
- `CONDUCTOR_IS_LOCAL`: `1` locally, `0` in cloud.
- `CONDUCTOR_DEFAULT_BRANCH`: local only.
- `CONDUCTOR_PORT`: first of ten allocated local ports, local only.

Restrict port-dependent commands with `available_in = [ "local" ]` or provide a separate cloud-compatible command. Use `CONDUCTOR_WORKSPACE_NAME` to isolate databases, app IDs, and other resources. Use `CONDUCTOR_ROOT_PATH` for shared caches only locally.

Repository variables can be shared or environment-specific:

```toml
[environment_variables]
API_BASE_URL = "https://example.invalid"

[environment_variables.local]
APP_TARGET = "local"

[environment_variables.cloud]
APP_TARGET = "cloud"
```

## Script roles

- `scripts.setup`: dependency installs, generated files, symlinks, and workspace-specific initialization.
- `scripts.run.<id>`: long-running apps, servers, workers, or test watchers launched from the Run button.
- `scripts.archive`: deterministic cleanup outside the workspace and local shared-cache maintenance.
- `scripts.run_mode`: `concurrent` when instances are isolated; `nonconcurrent` for one fixed port, database, Docker stack, or other exclusive resource.

By repository convention, keep these scripts under `.conductor/` as `setup.sh`, `run.sh`, `shutdown.sh`, or `archive.sh`, and keep gitignored logs there too. Preserve a deliberate existing `script/` or `bin/` layout because Conductor does not require these names. Route setup output to `.conductor/setup.log` with a pipefail-preserving command such as `bash -o pipefail -c './.conductor/setup.sh 2>&1 | tee .conductor/setup.log'`.

Prefer named run scripts:

```toml
[scripts]
run_mode = "concurrent"

[scripts.run.web]
command = "pnpm dev --port $CONDUCTOR_PORT"
default = true
icon = "play"
available_in = [ "local" ]

[scripts.run.worker]
command = "pnpm worker:dev"
icon = "server"
```

Keep multiple child processes in one foreground process group with `concurrently` or another supervisor. Do not background them with `&` because Conductor may leave ports and processes behind.

## Local-only behavior

Use Spotlight testing only when a project cannot run from a worktree and must execute from the repository root. Prefer normal workspace runs, then `nonconcurrent`, before Spotlight. Spotlight sync is one-way from the selected workspace to the root checkout.

For large local files, prefer copy-on-write (`cp -c` on macOS, `cp --reflink=auto` on Linux), then an explicit symlink or shared root cache. Cloud workspaces have no separate shared root cache.

Keep archive work focused on resources outside the workspace; do not rely on long graceful cleanup inside a run process.

Docs:

- https://conductor.build/docs/reference/scripts
- https://conductor.build/docs/reference/environment-variables
- https://conductor.build/docs/reference/shells
- https://conductor.build/docs/reference/scripts/spotlight-testing
