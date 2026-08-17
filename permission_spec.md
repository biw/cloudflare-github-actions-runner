# Private-repository permission specification

Status: Implemented

## Decision

Cloudflare GitHub Actions runners support **private GitHub repositories only**.

The GitHub App may remain installed for all repositories in a selected personal
account or organization. Repository visibility is enforced at runtime before
the system creates a just-in-time GitHub runner or starts a Cloudflare
Container.

The project does not change GitHub's contributor approval policies, repository
roles, organization membership, or GitHub App repository selection.

## Support matrix

| Repository owner        | Repository visibility | Support     |
| ----------------------- | --------------------- | ----------- |
| Personal account        | Private               | Supported   |
| Personal account        | Public                | Unsupported |
| Organization            | Private               | Supported   |
| Organization            | Public                | Unsupported |
| Enterprise organization | Internal              | Unsupported |

GitHub internal repositories are available only to organizations owned by a
GitHub Enterprise account and are readable by all members of that enterprise.
They are not equivalent to repositories that grant access only to explicitly
authorized users. See [About internal
repositories](https://docs.github.com/en/enterprise-cloud@latest/repositories/creating-and-managing-repositories/about-repositories#about-internal-repositories).

The runtime check must require GitHub's exact `private` visibility. It must not
infer support from a generic `private` boolean that might also represent an
internal repository.

## Trust boundary

For this project, access to a private repository is authorization to consume
that repository owner's Cloudflare runner capacity.

- A personal private repository is accessible to its owner and explicitly
  invited collaborators.
- An organization private repository is accessible according to GitHub's
  organization, team, outside-collaborator, and repository permissions.
- GitHub remains responsible for deciding whether a private-fork workflow needs
  approval before it queues a job.
- The runner does not independently classify members, collaborators, custom
  roles, pull-request authors, approvers, or rerun actors.

The system trusts GitHub's signed `workflow_job` delivery and current repository
visibility, but it does not treat a queued job from a public or internal
repository as authorized Cloudflare compute.

## Cloudflare runner intent

Repository visibility checks and unsupported-repository checks apply only to a
job that requests this runner.

A queued job has Cloudflare runner intent when any resolved `runs-on` label in
GitHub's signed `workflow_job` payload begins with the reserved `cloudflare-`
prefix. This includes:

- `cloudflare-ubuntu-latest`;
- every documented preset label;
- a valid or invalid `cloudflare-vcpu:` custom-machine label;
- conflicting Cloudflare labels; and
- an unknown or misspelled label in the reserved namespace.

The Worker must use the resolved webhook labels instead of parsing workflow
YAML. This preserves correct behavior for matrices, expressions, reusable
workflows, and multiple-label requests.

A job without a `cloudflare-` label must be ignored before any repository
visibility lookup, GitHub Check write, scheduler request, JIT runner creation,
or Cloudflare Container operation.

## Runtime authorization flow

For a signed `workflow_job: queued` delivery, the Worker must perform these
operations in order:

1. Verify the GitHub App webhook signature.
2. Verify the configured GitHub owner and App installation.
3. Parse the job ID, run ID, repository identity, head SHA, and resolved labels.
4. Ignore the delivery unless at least one label begins with `cloudflare-`.
5. Use the App installation token to fetch the repository's current visibility
   from GitHub.
6. If visibility is `private`, continue to normal label validation and
   scheduling.
7. If visibility is `public` or `internal`, create the unsupported-repository
   failure Check and stop.
8. If current visibility cannot be verified, fail closed, attempt a
   visibility-verification failure Check, and stop.

No unsupported or unverifiable repository may reach:

- custom-machine validation that starts a diagnostic runner;
- the account runner scheduler;
- cache-scope or cache-capability creation;
- GitHub JIT runner creation;
- a Cloudflare Container application or rollout change; or
- Cloudflare Container startup.

### Delayed provisioning

Scheduler admission is not sufficient authorization for later provisioning. A
private job may wait for capacity while an administrator changes its repository
to public or internal.

The provisioning workflow must fetch and require current `private` visibility
again immediately before creating the JIT runner. If the repository is no
longer private, it must release the scheduler reservation, create or update the
unsupported-repository Check, and stop without starting a Container.

The invalid-machine diagnostic path does not use the scheduler, so it must
perform the same current-visibility authorization immediately before creating
its diagnostic JIT runner.

## Unsupported-repository GitHub Check

Only a Cloudflare-targeting job from a public, internal, or unverifiable
repository may create this Check. Installing the App must not create Checks on
its own, and unrelated GitHub-hosted or self-hosted jobs must never create one.

The Check should use:

- name: `Cloudflare runner eligibility`;
- status: `completed`;
- conclusion: `failure`;
- title: `Cloudflare runners require a private repository`;
- the rejected GitHub job ID as part of its stable external identity; and
- a details URL that explains the private-repository requirement.

The summary must identify the repository, report its detected visibility or the
visibility-verification failure, state that no Cloudflare runner was started,
and tell the user to choose a different runner or use a private repository.

For example:

```text
Cloudflare runner did not start.

owner/repository is public. cloudflare-github-actions-runner supports private
repositories only. Use another runs-on label or change the repository
visibility to private.
```

Webhook delivery is at-least-once. Redelivery, retries, and both initial and
pre-provision visibility checks must converge on at most one eligibility Check
per GitHub job. A later verification may update the existing Check but must not
create duplicates.

If the Checks API call fails, the Worker must log a structured, non-sensitive
error and continue to reject the job. UI reporting failure must never become
authorization to start a runner.

The App cannot fail an individual queued GitHub Actions job through GitHub's
workflow-job API. The original unsupported job may remain queued until GitHub's
self-hosted runner timeout. The eligibility Check provides immediate feedback
without starting billable runner compute. See [Self-hosted runner
routing](https://docs.github.com/en/actions/reference/runners/self-hosted-runners#routing-precedence-for-self-hosted-runners).

The Worker must not cancel the entire workflow run, post a pull-request comment,
or start a small rejection Container merely to improve this error presentation.

## Private-repository behavior

After current private visibility is verified:

- A valid preset or custom-machine label follows the existing scheduler and
  provisioning path.
- An invalid, unknown, or conflicting Cloudflare label follows the existing
  diagnostic-runner path.
- The diagnostic runner uses the exact requested labels, prints a GitHub error,
  exits its pre-job hook with a non-zero status, and runs no user workflow
  steps.
- GitHub's native approval and rerun behavior remains authoritative.

The diagnostic runner is billable Container compute. It is permitted only for
private repositories because its initiators already have explicit repository
access.

## GitHub App permissions

The runtime GitHub App requires the existing repository permissions used to
receive and inspect jobs, download the trusted runner image source, and create
repository-scoped JIT runners.

This design additionally requires:

- **Checks: Write**, used only to create or update an eligibility Check for a
  Cloudflare-targeting job rejected by the private-visibility requirement.

This design does not require:

- Actions: Write;
- Issues or Pull requests: Write;
- organization member access;
- organization Administration access;
- collaborator lookups; or
- a runner-owned user authorization database.

Existing installations that do not grant Checks: Write must be upgraded before
setup reports the private-repository failure experience as fully configured.
Failure to obtain the permission must not weaken runtime visibility
enforcement.

See [REST API endpoints for check
runs](https://docs.github.com/en/rest/checks/runs) for the GitHub App permission
and Check output model.

## Setup and installation scope

Setup may continue to recommend installing the GitHub App for **All
repositories**. GitHub does not provide an automatically maintained "all
private repositories" installation scope, and runtime visibility enforcement
is the security boundary.

Setup must clearly report:

- the package runs jobs only for private repositories;
- public and internal Cloudflare-targeting jobs are rejected at runtime;
- unrelated jobs are ignored and receive no eligibility Check; and
- the App holds its configured repository permissions anywhere it is installed,
  even when runner compute is disabled by visibility.

Setup must not:

- change repository visibility;
- change public- or private-fork workflow approval policies;
- change organization membership or repository roles;
- require a selected-repositories installation; or
- store a list of private repositories as an authorization manifest.

Teardown has no GitHub Actions approval policy to restore. It follows the
existing ownership manifest and resource-tag protections for resources created
by setup.

## Failure precedence

Repository visibility authorization takes precedence over machine validation.

| Resolved job request                    | Current visibility | Result                                                  |
| --------------------------------------- | ------------------ | ------------------------------------------------------- |
| No `cloudflare-` label                  | Any                | Ignore completely                                       |
| Valid Cloudflare label                  | Private            | Start normal runner flow                                |
| Invalid or conflicting Cloudflare label | Private            | Start existing diagnostic runner                        |
| Any Cloudflare label                    | Public             | Failure Check; no JIT runner or Container               |
| Any Cloudflare label                    | Internal           | Failure Check; no JIT runner or Container               |
| Any Cloudflare label                    | Unverifiable       | Failure Check when possible; no JIT runner or Container |

## Acceptance criteria

The implementation is complete when automated tests demonstrate all of the
following:

1. Unrelated workflow jobs are ignored without a repository API call or Check
   write.
2. Known preset, custom, malformed, conflicting, and unknown `cloudflare-`
   labels are recognized as Cloudflare runner intent.
3. A valid Cloudflare job in a private personal repository reaches normal
   provisioning.
4. A valid Cloudflare job in a private organization repository reaches normal
   provisioning.
5. Invalid Cloudflare sizing in a private repository reaches the existing
   diagnostic runner.
6. Every Cloudflare-targeting public or internal job creates or updates one
   eligibility Check and performs no scheduler, cache, JIT runner, Container
   application, rollout, or Container startup operation.
7. Repository visibility lookup failures fail closed and perform no runner
   provisioning.
8. A job admitted while private is rejected without runner provisioning if the
   repository becomes public or internal before capacity is available.
9. GitHub webhook redeliveries do not create duplicate eligibility Checks.
10. A Checks API failure cannot cause a rejected job to proceed.
11. The GitHub App requests Checks: Write but not Actions: Write, Issues: Write,
    Pull requests: Write, organization member access, or organization
    Administration access for this feature.
12. Setup does not read or mutate GitHub contributor approval policies.

End-to-end validation must additionally demonstrate:

1. A private-repository job runs on `cloudflare-ubuntu-latest`.
2. A private-repository job with invalid custom sizing fails through the
   diagnostic runner before workflow steps execute.
3. A public-repository job targeting `cloudflare-ubuntu-latest` starts no
   Cloudflare Container and displays the eligibility Check on the associated
   GitHub commit or pull request.
4. An unrelated job in that public repository creates no eligibility Check.

## Out of scope

- Running Cloudflare GitHub Actions jobs for public or internal repositories.
- Changing or enforcing GitHub fork-contributor approval policies.
- Protecting against a compromised or malicious user with access to a private
  repository.
- Custom member, collaborator, approver, or rerun authorization.
- Automatically maintaining a selected-repositories App installation.
- Cancelling an entire workflow run because one job targets an unsupported
  repository.
- Starting any diagnostic or rejection Container for an unsupported repository.
- Guaranteeing that GitHub immediately completes its original unsupported
  Actions job.
