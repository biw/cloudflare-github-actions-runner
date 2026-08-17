export interface GitHubRepositoryTarget {
  owner: string;
  repository: string;
}

export interface GitHubCredentialEnvironment {
  /**
   * The repository runner PAT from the original single-repository POC. It is
   * kept as a read-only migration fallback so an existing installation can be
   * upgraded by running `init` once.
   */
  GITHUB_OWNER?: string;
  GITHUB_REPOSITORY?: string;
  LEGACY_GITHUB_OWNER?: string;
  LEGACY_GITHUB_REPOSITORY?: string;
  GITHUB_RUNNER_TOKEN?: string;
  /** The sole GitHub account or organization served by this runner pool. */
  GITHUB_RUNNER_OWNER?: string;
}

export interface GitHubDynamicSecretEnvironment extends GitHubCredentialEnvironment {
  readonly [binding: `GITHUB_RUNNER_TOKEN_${string}`]: string | undefined;
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export function parseGitHubRepositoryTarget(value: string): GitHubRepositoryTarget | undefined {
  const [owner, repository, ...rest] = value.trim().split("/");
  if (owner === undefined || repository === undefined || rest.length > 0 || owner === "" || repository === "") {
    return undefined;
  }
  return { owner, repository };
}

export function githubRepositoryName(target: GitHubRepositoryTarget): string {
  return `${target.owner}/${target.repository}`;
}

export function sameGitHubRepository(left: GitHubRepositoryTarget, right: GitHubRepositoryTarget): boolean {
  return (
    normalized(left.owner) === normalized(right.owner) && normalized(left.repository) === normalized(right.repository)
  );
}

/**
 * A Worker belongs to one Cloudflare account and explicitly serves one GitHub
 * account or organization. GitHub App deliveries fail closed until setup
 * persists that mapping; the caller retains a narrowly scoped legacy-PAT
 * migration path for the original repository only.
 */
export function runnerPoolAcceptsGitHubRepository(
  env: Pick<GitHubCredentialEnvironment, "GITHUB_RUNNER_OWNER">,
  target: GitHubRepositoryTarget,
): boolean {
  const configuredOwner = env.GITHUB_RUNNER_OWNER?.trim();
  return (
    configuredOwner !== undefined && configuredOwner !== "" && normalized(configuredOwner) === normalized(target.owner)
  );
}

export function legacyGitHubRepositoryFor(env: GitHubCredentialEnvironment): GitHubRepositoryTarget | undefined {
  return legacyTarget(env);
}

export async function githubRunnerTokenBindingName(owner: string): Promise<`GITHUB_RUNNER_TOKEN_${string}`> {
  return `GITHUB_RUNNER_TOKEN_${await sha256(normalized(owner))}`;
}

function legacyTarget(env: GitHubCredentialEnvironment): GitHubRepositoryTarget | undefined {
  const owner = env.LEGACY_GITHUB_OWNER ?? env.GITHUB_OWNER;
  const repository = env.LEGACY_GITHUB_REPOSITORY ?? env.GITHUB_REPOSITORY;
  if (owner === undefined || repository === undefined) {
    return undefined;
  }
  return parseGitHubRepositoryTarget(`${owner}/${repository}`);
}

export async function githubRunnerTokenFor(
  env: GitHubDynamicSecretEnvironment,
  target: GitHubRepositoryTarget,
): Promise<string | undefined> {
  const binding = await githubRunnerTokenBindingName(target.owner);
  const configured = env[binding];
  if (configured !== undefined && configured.trim() !== "") {
    return configured;
  }

  const legacy = legacyTarget(env);
  if (legacy !== undefined && sameGitHubRepository(target, legacy)) {
    return env.GITHUB_RUNNER_TOKEN?.trim() === "" ? undefined : env.GITHUB_RUNNER_TOKEN;
  }
  return undefined;
}
