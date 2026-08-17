import { parseGitHubRepositoryTarget, type GitHubRepositoryTarget } from "./github-repository";

/**
 * These are the only source files that change the managed runner image. The
 * remote builder hashes exactly this ordered list, so ordinary Worker and
 * documentation commits do not rebuild an identical image.
 */
export const RUNNER_IMAGE_INPUT_PATHS = [
  "docker/Dockerfile",
  "docker/actions-runner-results-proxy.patch",
  "docker/start-runner.sh",
  "docker/invalid-runner-hook.sh",
  "docker/job-started-hook.sh",
  "docker/report-container-usage.sh",
  "docker/resource-trace.sh",
  "docker/cf-resource-mark.sh",
  "docker/cf-resource-trace.sh",
  "docker/runner-results-proxy.mjs",
] as const;

/**
 * A pinned daemonless OCI builder runs directly inside one disposable
 * Cloudflare Container. It builds the trusted runner Dockerfile without
 * requiring Docker on the computer running setup or a nested Docker daemon.
 */
// The debug variant deliberately supplies /busybox/sh, wget, tar, and core
// utilities. The command host invokes Kaniko by its absolute executor path;
// the pinned digest, rather than this readable tag, is authoritative.
export const RUNNER_IMAGE_BUILDER_KANIKO_SOURCE_IMAGE =
  "gcr.io/kaniko-project/executor:debug@sha256:2562c4fe551399514277ffff7dcca9a3b1628c4ea38cb017d7286dc6ea52f4cd";
export const RUNNER_IMAGE_BUILDER_BOOTSTRAP_TAG = "kaniko-v1";

export interface RunnerImageBuilderConfigurationEnvironment {
  CLOUDFLARE_ACCOUNT_ID: string;
  RUNNER_IMAGE_BUILDER_IMAGE_NAME: string;
}

export interface RunnerImageSource {
  repository: GitHubRepositoryTarget;
  ref: string;
}

export interface RunnerImageConfigurationEnvironment {
  CLOUDFLARE_ACCOUNT_ID: string;
  RUNNER_IMAGE_NAME: string;
  RUNNER_IMAGE_SOURCE_REPOSITORY: string;
  RUNNER_IMAGE_SOURCE_REF: string;
}

export interface RunnerImageSourcePush {
  repository: GitHubRepositoryTarget;
  ref: string;
}

const imageNamePattern = /^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/u;
const sourceDigestPattern = /^[a-f0-9]{24}$/u;
const sourceArchiveWorkflowIdPattern = /^[A-Za-z0-9_-]{1,240}$/u;
const publicSourceDownloadError =
  /^Could not download [A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[A-Za-z0-9_./-]+\. Grant the GitHub App Contents: Read or make the source repository public\.$/u;
const publicRunnerImageOperationalErrors = new Set([
  "Cloudflare image builder bootstrap lost its deployment-scoped claim",
  "Cloudflare did not finish the builder deployment rollout before private bootstrap",
  "Cloudflare did not finish the shared private builder bootstrap",
  "Cloudflare runner image build did not complete within 29 minutes",
  "Cloudflare runner image build queue did not drain after three source builds",
]);

/** Return only build failures that cannot contain credentials or container output. */
export function publicRunnerImageBuildError(cause: unknown): string | undefined {
  if (!(cause instanceof Error)) {
    return undefined;
  }
  if (publicSourceDownloadError.test(cause.message)) {
    return cause.message;
  }
  if (publicRunnerImageOperationalErrors.has(cause.message)) {
    return cause.message;
  }
  if (
    cause.message ===
    "RUNNER_IMAGE_SOURCE_REPOSITORY and RUNNER_IMAGE_SOURCE_REF must identify a GitHub repository and branch"
  ) {
    return cause.message;
  }
  return undefined;
}

export function runnerImageSource(env: RunnerImageConfigurationEnvironment): RunnerImageSource | undefined {
  const repository = parseGitHubRepositoryTarget(env.RUNNER_IMAGE_SOURCE_REPOSITORY);
  if (repository === undefined || env.RUNNER_IMAGE_SOURCE_REF.trim() === "") {
    return undefined;
  }
  return { repository, ref: env.RUNNER_IMAGE_SOURCE_REF.trim() };
}

export function runnerImageName(
  env: Pick<RunnerImageConfigurationEnvironment, "RUNNER_IMAGE_NAME">,
): string | undefined {
  const value = env.RUNNER_IMAGE_NAME.trim();
  return imageNamePattern.test(value) ? value : undefined;
}

export function runnerImageReference(
  env: Pick<RunnerImageConfigurationEnvironment, "CLOUDFLARE_ACCOUNT_ID" | "RUNNER_IMAGE_NAME">,
  sourceDigest: string,
): string | undefined {
  const repository = runnerImageRepository(env);
  if (!sourceDigestPattern.test(sourceDigest) || repository === undefined) {
    return undefined;
  }
  return `${repository}:runner-${sourceDigest}`;
}

/** Return the account-private repository that holds managed runner images. */
export function runnerImageRepository(
  env: Pick<RunnerImageConfigurationEnvironment, "CLOUDFLARE_ACCOUNT_ID" | "RUNNER_IMAGE_NAME">,
): string | undefined {
  const name = runnerImageName(env);
  if (name === undefined || env.CLOUDFLARE_ACCOUNT_ID.trim() === "") {
    return undefined;
  }
  return `registry.cloudflare.com/${env.CLOUDFLARE_ACCOUNT_ID}/${name}`;
}

/** Return the account-private daemonless builder image reference. */
export function runnerImageBuilderBootstrapReference(
  env: RunnerImageBuilderConfigurationEnvironment,
): string | undefined {
  const name = runnerImageName({ RUNNER_IMAGE_NAME: env.RUNNER_IMAGE_BUILDER_IMAGE_NAME });
  if (name === undefined || env.CLOUDFLARE_ACCOUNT_ID.trim() === "") {
    return undefined;
  }
  return `registry.cloudflare.com/${env.CLOUDFLARE_ACCOUNT_ID}/${name}:${RUNNER_IMAGE_BUILDER_BOOTSTRAP_TAG}`;
}

/**
 * The Docker builder receives source through a private R2 object rather than
 * fetching from GitHub itself. This keeps the GitHub App credential in Worker
 * code and gives the Workflow a streaming hand-off to the builder.
 */
export function runnerImageSourceArchiveKey(workflowId: string): string | undefined {
  return sourceArchiveWorkflowIdPattern.test(workflowId) ? `runner-image-source/${workflowId}.tar.gz` : undefined;
}

/**
 * A signed GitHub push may request a build only for the configured source
 * repository and branch. The source itself remains fixed in Worker vars; a
 * webhook cannot select an arbitrary Dockerfile or registry destination.
 */
export function isRunnerImageSourcePush(push: RunnerImageSourcePush, source: RunnerImageSource | undefined): boolean {
  return (
    source !== undefined &&
    push.repository.owner.toLowerCase() === source.repository.owner.toLowerCase() &&
    push.repository.repository.toLowerCase() === source.repository.repository.toLowerCase() &&
    push.ref === `refs/heads/${source.ref}`
  );
}

export function runnerImageSourceDigestCommand(sourceDirectory = "/workspace/source"): string {
  const quotedPaths = RUNNER_IMAGE_INPUT_PATHS.map((path) => `'${path}'`).join(" ");
  return `set -eu\ncd ${sourceDirectory}\ndigest_input="$(mktemp)"\ntrap 'rm -f "$digest_input"' EXIT\nfor path in ${quotedPaths}; do\n  test -f "$path"\n  printf '%s\\0' "$path" >> "$digest_input"\n  sha256sum "$path" >> "$digest_input"\ndone\nsha256sum "$digest_input" | cut -c1-24`;
}

export function runnerImageBuildCommand(): string {
  return [
    "set -eu",
    'config_dir="$(mktemp -d)"',
    'cleanup() { rm -rf "$config_dir" /workspace/source; }',
    "trap cleanup EXIT",
    'printf \'%s\' "$CF_REGISTRY_PASSWORD" | DOCKER_CONFIG="$config_dir" docker login --username "$CF_REGISTRY_USERNAME" --password-stdin registry.cloudflare.com >/dev/null',
    // The image ID is enough output for this Worker-mediated command. Keeping
    // BuildKit's progress stream quiet avoids buffering verbose Docker output
    // in the Durable Object while an image is being assembled remotely.
    'DOCKER_CONFIG="$config_dir" docker build --quiet --network=host --platform linux/amd64 --file /workspace/source/docker/Dockerfile --tag "$RUNNER_IMAGE_REFERENCE" /workspace/source',
    'DOCKER_CONFIG="$config_dir" docker push "$RUNNER_IMAGE_REFERENCE"',
  ].join("\n");
}

export function runnerImageExtractionCommand(): string {
  return "set -eu\nrm -rf /workspace/source\nmkdir -p /workspace/source\ntar -xzf - -C /workspace/source --strip-components=1";
}
