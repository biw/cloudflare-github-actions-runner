import type { GitHubRepositoryTarget } from "./github-repository";
import type { ResourceTraceContainerConfiguration } from "./resource-traces";
import type { RunnerCacheContainerConfiguration } from "./runner-cache";
import type { RunnerProfile } from "./runner-profiles";

export interface GitHubRunnerEnvironment {
  GITHUB_RUNNER_GROUP_ID: string;
}

export interface GitHubRunnerCredentials extends GitHubRepositoryTarget {
  token: string;
}

export interface RunnerState {
  status: "starting" | "running" | "stopping" | "stopped" | string;
}

export interface RunnerContainer {
  getState(): Promise<RunnerState>;
  start(options: { envVars: Record<string, string> }): Promise<void>;
}

interface RunnerEnvironmentVariables {
  [name: string]: string;
  ACTIONS_RUNNER_JIT_CONFIG: string;
  CF_CONTAINER_INSTANCE_TYPE: string;
  CF_CONTAINER_MEMORY_GIB: string;
  CF_CONTAINER_DISK_GB: string;
}

export interface ProvisionDependencies {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /**
   * Persists the JIT runner identity before the Container can start and GitHub
   * can deliver an `in_progress` assignment for it.
   */
  onJitRunnerCreated?: (runnerId: number) => Promise<void>;
  resourceTrace?: ResourceTraceContainerConfiguration;
  /** Short-lived, runner-scoped cache capability; never an R2 API token. */
  runnerCache?: RunnerCacheContainerConfiguration;
  /**
   * Use the labels from a signed workflow_job delivery instead of deriving
   * them from the profile. This lets a diagnostic JIT runner match an invalid
   * request and fail that one GitHub Actions job before workflow steps run.
   */
  jitLabels?: readonly string[];
  /** A non-secret pre-job-hook message for a diagnostic runner. */
  jobStartedHookMessage?: string;
}

const defaultDependencies: ProvisionDependencies = {
  fetch: (input, init) => fetch(input, init),
};

export type ProvisionResult =
  | { kind: "started"; runnerName: string; runnerId: number }
  | { kind: "already-active"; runnerName: string }
  | { kind: "github-error"; status: number }
  | { kind: "invalid-github-response" }
  | { kind: "invalid-runner-group" }
  | { kind: "container-start-error"; runnerId: number };

const githubJitConfigSchema = z.object({
  encoded_jit_config: z.string(),
  runner: z.object({ id: z.number().int().positive() }),
});
const githubErrorResponseSchema = z.object({ message: z.string().optional() });

const githubHeaders = (token: string): HeadersInit => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "User-Agent": "cloudflare-github-actions-runner",
  "X-GitHub-Api-Version": "2022-11-28",
});

function githubRunnerUrl(target: GitHubRepositoryTarget, suffix = ""): string {
  return `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}/actions/runners${suffix}`;
}

function runnerGroupId(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export type GitHubRunnerDeletionResult =
  | { kind: "deleted" }
  | { kind: "not-found" }
  | { kind: "busy" }
  | { kind: "failed"; status: number };

export async function deleteGitHubRunner(
  credentials: GitHubRunnerCredentials,
  runnerId: number,
  dependencies: ProvisionDependencies = defaultDependencies,
): Promise<GitHubRunnerDeletionResult> {
  const response = await dependencies.fetch(`${githubRunnerUrl(credentials)}/${runnerId}`, {
    method: "DELETE",
    headers: githubHeaders(credentials.token),
  });

  if (response.ok) {
    return { kind: "deleted" };
  }
  if (response.status === 404) {
    return { kind: "not-found" };
  }
  if (response.status === 422) {
    return { kind: "busy" };
  }
  if (!response.ok) {
    console.error("Could not remove the JIT runner after container startup failed", {
      runnerId,
      status: response.status,
    });
  }
  return { kind: "failed", status: response.status };
}

export async function provisionRunner(
  env: GitHubRunnerEnvironment,
  credentials: GitHubRunnerCredentials,
  runner: RunnerContainer,
  runnerName: string,
  profile: RunnerProfile,
  dependencies: ProvisionDependencies = defaultDependencies,
): Promise<ProvisionResult> {
  const currentState = await runner.getState();
  if (currentState.status === "starting" || currentState.status === "running") {
    return { kind: "already-active", runnerName };
  }

  const groupId = runnerGroupId(env.GITHUB_RUNNER_GROUP_ID);
  if (groupId === undefined) {
    return { kind: "invalid-runner-group" };
  }

  const jitLabels = dependencies.jitLabels ?? ["self-hosted", "Linux", "X64", ...profile.labels];
  const response = await dependencies.fetch(`${githubRunnerUrl(credentials)}/generate-jitconfig`, {
    method: "POST",
    headers: {
      ...githubHeaders(credentials.token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: runnerName,
      runner_group_id: groupId,
      labels: jitLabels,
      work_folder: "_work",
    }),
  });

  if (!response.ok) {
    let message: string | undefined;
    try {
      const errorResponse = githubErrorResponseSchema.safeParse(await response.json());
      if (errorResponse.success) {
        message = errorResponse.data.message;
      }
    } catch {
      // GitHub error responses are normally JSON, but status and headers are enough to diagnose failures.
    }

    console.error("GitHub rejected the JIT runner configuration", {
      runnerName,
      status: response.status,
      message,
      acceptedPermissions: response.headers.get("X-Accepted-GitHub-Permissions"),
      requestId: response.headers.get("X-GitHub-Request-Id"),
    });
    return { kind: "github-error", status: response.status };
  }

  let jitConfig;
  try {
    const parsedJitConfig = githubJitConfigSchema.safeParse(await response.json());
    if (!parsedJitConfig.success) {
      return { kind: "invalid-github-response" };
    }
    jitConfig = parsedJitConfig.data;
  } catch {
    return { kind: "invalid-github-response" };
  }

  try {
    await dependencies.onJitRunnerCreated?.(jitConfig.runner.id);
  } catch (error) {
    console.error("Could not record the JIT runner before starting its container", {
      runnerName,
      runnerId: jitConfig.runner.id,
      error: error instanceof Error ? error.message : String(error),
    });
    await deleteGitHubRunner(credentials, jitConfig.runner.id, dependencies);
    return { kind: "container-start-error", runnerId: jitConfig.runner.id };
  }

  try {
    const envVars: RunnerEnvironmentVariables = {
      ACTIONS_RUNNER_JIT_CONFIG: jitConfig.encoded_jit_config,
      CF_CONTAINER_INSTANCE_TYPE: profile.instanceType,
      CF_CONTAINER_MEMORY_GIB: profile.memoryGib,
      CF_CONTAINER_DISK_GB: profile.diskGb,
    };
    if (dependencies.jobStartedHookMessage !== undefined) {
      envVars.CF_INVALID_RUNNER_MESSAGE = dependencies.jobStartedHookMessage;
    }
    if (dependencies.resourceTrace !== undefined) {
      envVars.CF_RESOURCE_TRACE_ENDPOINT = dependencies.resourceTrace.endpoint;
      envVars.CF_RESOURCE_TRACE_AUTHORIZATION = dependencies.resourceTrace.authorization;
    }
    if (dependencies.runnerCache !== undefined) {
      envVars.CF_RUNNER_CACHE_ENDPOINT = dependencies.runnerCache.endpoint;
      envVars.CF_RUNNER_CACHE_AUTHORIZATION = dependencies.runnerCache.authorization;
    }
    await runner.start({
      envVars,
    });
  } catch (error) {
    console.error("Could not start the GitHub Actions runner container", {
      runnerName,
      error: error instanceof Error ? error.message : String(error),
    });
    await deleteGitHubRunner(credentials, jitConfig.runner.id, dependencies);
    return { kind: "container-start-error", runnerId: jitConfig.runner.id };
  }

  return {
    kind: "started",
    runnerName,
    runnerId: jitConfig.runner.id,
  };
}
import { z } from "zod";
