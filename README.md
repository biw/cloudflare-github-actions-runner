# Cloudflare Containers GitHub Actions Runner

[![CI](https://badgen.net/github/checks/biw/cloudflare-github-actions-runner)](https://github.com/biw/cloudflare-github-actions-runner/actions)
[![npm version](https://badgen.net/npm/v/cloudflare-github-actions-runner)](https://www.npmjs.com/package/cloudflare-github-actions-runner)
[![npm downloads](https://badgen.net/npm/dt/cloudflare-github-actions-runner)](https://www.npmjs.com/package/cloudflare-github-actions-runner)

Run GitHub Actions jobs in an ephemeral [Cloudflare Containers](https://developers.cloudflare.com/containers/). A signed GitHub App `workflow_job` webhook provisions a repository-scoped GitHub [just-in-time runner](https://docs.github.com/en/actions/reference/security/secure-use#using-just-in-time-runners).

## Quick start

```sh
npx -y cloudflare-github-actions-runner@latest
```

The interactive CLI deploys the runner pool and guides you through selecting its GitHub account or organization, creating its GitHub App, and configuring its single private R2 storage bucket with an optional dependency cache.

## Private repositories only

Cloudflare runners run jobs only when GitHub reports the repository's current visibility as exactly **private**. Public and GitHub Enterprise internal repositories cannot use the runner, even when the GitHub App is installed for **All repositories**.

For a job whose resolved `runs-on` labels include the reserved `cloudflare-` prefix, the Worker checks visibility before machine validation or scheduling and again immediately before creating a just-in-time runner. An unsupported or unverifiable repository starts no runner or Cloudflare Container. The App instead reports a failed **Cloudflare runner eligibility** Check on the associated commit when GitHub permits it.

Jobs using GitHub-hosted runners or unrelated self-hosted labels are ignored and receive no eligibility Check. GitHub does not expose an API for failing only the unsupported queued job, so it may remain queued until GitHub's self-hosted runner timeout; use another `runs-on` label or make the repository private.

The GitHub App holds its configured permissions in every repository where it is installed. Runtime visibility enforcement disables Cloudflare compute in public and internal repositories; it does not narrow the App installation itself or change GitHub's contributor approval policies.

## Choose a runner

Use one label directly in a workflow:

| `runs-on` label                | Machine type  | vCPU |  Memory |  Disk |
| ------------------------------ | ------------- | ---: | ------: | ----: |
| `cloudflare-lite`              | `linux/amd64` | 1/16 | 256 MiB |  2 GB |
| `cloudflare-basic`             | `linux/amd64` |  1/4 |   1 GiB |  4 GB |
| `cloudflare-standard-1`        | `linux/amd64` |  1/2 |   4 GiB |  8 GB |
| `cloudflare-standard-2`        | `linux/amd64` |    1 |   6 GiB | 12 GB |
| `cloudflare-standard-3`        | `linux/amd64` |    2 |   8 GiB | 16 GB |
| **`cloudflare-ubuntu-latest`** | `linux/amd64` |    2 |   8 GiB | 16 GB |
| `cloudflare-standard-4`        | `linux/amd64` |    4 |  12 GiB | 20 GB |

All profiles use the same managed Ubuntu 24.04 runner image. Values come from the [Cloudflare Containers instance types](https://developers.cloudflare.com/containers/platform-details/limits/).

### Custom Machines Sizes

Preset labels are convenient, but custom machines let each job request exactly the compute it needs. Put the vCPU, memory, and disk allocation directly in `runs-on`; there is no per-size Cloudflare setup and no additional runner image to build. The account scheduler reserves capacity, configures an idle custom slot, and starts a fresh disposable runner with the same managed Ubuntu image.

```yaml
jobs:
  build:
    runs-on: "cloudflare-vcpu:2-memory_mib:6144-disk_mb:12000"
```

The label is self-contained, so different jobs—even in the same workflow—can choose different shapes:

| `runs-on` label                                    | vCPU | Memory | Disk  |
| -------------------------------------------------- | ---: | ------ | ----- |
| `cloudflare-vcpu:1-memory_mib:4096-disk_mb:8000`   |    1 | 4 GiB  | 8 GB  |
| `cloudflare-vcpu:2-memory_mib:6144-disk_mb:12000`  |    2 | 6 GiB  | 12 GB |
| `cloudflare-vcpu:4-memory_mib:12288-disk_mb:20000` |    4 | 12 GiB | 20 GB |

- Custom values use 1–4 whole vCPUs, up to 12,288 MiB memory, and up to 20,000 MB disk
- Memory must provide at least 3,072 MiB per vCPU, and disk cannot exceed 2 GB per GiB of memory.
- Invalid requests fail visibly in the **Set up runner** GitHub runner step before repository code executes.
- The first job for a new shape may remain queued for a few minutes while Cloudflare rolls that configuration onto an idle custom slot. The runner image is reused rather than rebuilt.

## Caching

The CLI automatically sets up caching to use Cloudflare R2. Use `actions/cache` normally. JavaScript actions, including `actions/cache` and `actions/setup-node`, are transparently backed by the private R2 bucket; artifact uploads and job results continue to use GitHub. PR caches are scoped to their merge ref and can fall back to the default-branch cache, matching GitHub Actions behavior.

```yaml
jobs:
  ci:
    runs-on: cloudflare-ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v6
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run check
```

## What setup does

The interactive setup:

1. Verifies your Cloudflare user, account, Containers access, and Docker-free remote builder support.
2. Lets you select the Cloudflare account that owns and bills for the shared runner pool.
3. Deploys the Worker, runner profiles, and managed runner image.
4. Maps the selected Cloudflare account to one GitHub personal account or organization, then creates or reuses that pool's GitHub App. Install it for **All repositories** in that selected account or organization.
5. Creates one private R2 storage bucket for temporary image-build sources and, optionally, dependency caches with a FIFO quota.
6. Records a unique installation ID, immutable Cloudflare and GitHub resource IDs, and ownership tags on the Worker, D1 database, and R2 bucket.

- One Cloudflare runner pool serves exactly one GitHub account or organization. Run setup again to create a separate mapping for another Cloudflare account.
- An App installation covers all selected repositories in that target, including future repositories.
- App keys, installation tokens, and Cloudflare credentials stay out of runner Containers.

## Teardown

To undo setup from a checkout, run:

```sh
npx -y cloudflare-github-actions-runner@latest teardown
```

The interactive command asks which Cloudflare account and which GitHub personal account or organization to inspect.

### Safe teardown with ownership tags

Setup stores a versioned ownership manifest in the deployed Worker's plain-text `RUNNER_RESOURCE_MANIFEST` variable. It records the installation ID and the exact resource names, immutable IDs, image references, and managed R2 prefixes created for that runner pool. The manifest contains resource identities, not API tokens, private keys, or webhook secrets.

Setup also applies two Cloudflare account tags to the Worker, D1 database, and R2 bucket:

- `managed-by=cloudflare-github-actions-runner`
- `runner-installation-id=<installation UUID>`

These resources act as independently verifiable ownership anchors. Container applications, Workflows, and registry images are tracked by immutable ID or reference in the manifest.

Teardown fails closed.

The selected Cloudflare account and GitHub owner, installation manifest, immutable resource IDs, and both tags on all three ownership anchors must agree before it produces any deletion operations. The Worker queries the Cloudflare Tags API with the account-owned token; that token never leaves the Worker. If any check fails, teardown deletes nothing.

## License

MIT
