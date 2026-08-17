import { githubAppStatus, hasGitHubAppWebhookSecret, type GitHubAppEnvironment } from "./github-app";
import { validCloudflareResourceTagging } from "./runner-resource-ownership";

export interface RunnerSetupValidationEnvironment extends GitHubAppEnvironment {
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_CONTAINERS_API_TOKEN?: string;
  CUSTOM_RUNNER_APPLICATION?: string;
  RUNNER_SETUP_VALIDATION_TOKEN?: string;
  RESOURCE_TRACE_SIGNING_KEY?: string;
  RUNNER_CACHE_SIGNING_KEY?: string;
}

export interface RunnerSetupValidationDependencies {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export interface RunnerSetupTokenStatus {
  cloudflareContainersToken: boolean;
  cloudflareRegistryPush: boolean;
  cloudflareResourceTagging: boolean;
  githubApp: boolean;
  githubAppWebhookSecret: boolean;
  resourceTraceSigningKey: boolean;
  runnerCacheSigningKey: boolean;
}

export interface CloudflareContainersTokenIdentity {
  id: string;
  status: "active" | "disabled" | "expired";
}

const defaultDependencies: RunnerSetupValidationDependencies = {
  fetch: (input, init) => fetch(input, init),
};

function hasValue(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

const successfulResponseSchema = z.object({ success: z.literal(true) });
const registryCredentialsResponseSchema = z.object({
  success: z.literal(true),
  result: z.object({ username: z.string(), password: z.string() }),
});
const cloudflareTokenIdentityResponseSchema = z.object({
  success: z.literal(true),
  result: z.object({
    id: z.string().length(32),
    status: z.enum(["active", "disabled", "expired"]),
  }),
});

function cloudflareApplicationsUrl(env: RunnerSetupValidationEnvironment): string | undefined {
  if (!hasValue(env.CLOUDFLARE_ACCOUNT_ID)) {
    return undefined;
  }
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/containers/applications`;
}

async function validCloudflareContainersToken(
  env: RunnerSetupValidationEnvironment,
  dependencies: RunnerSetupValidationDependencies,
): Promise<boolean> {
  const url = cloudflareApplicationsUrl(env);
  if (url === undefined || !hasValue(env.CLOUDFLARE_CONTAINERS_API_TOKEN)) {
    return false;
  }

  try {
    const response = await dependencies.fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${env.CLOUDFLARE_CONTAINERS_API_TOKEN}`,
      },
    });
    if (!response.ok) {
      return false;
    }
    return successfulResponseSchema.safeParse(await response.json()).success;
  } catch {
    return false;
  }
}

/** Resolve only the revocable token ID; the credential itself never leaves the Worker. */
export async function cloudflareContainersTokenIdentity(
  env: RunnerSetupValidationEnvironment,
  dependencies: RunnerSetupValidationDependencies = defaultDependencies,
): Promise<CloudflareContainersTokenIdentity | undefined> {
  if (!hasValue(env.CLOUDFLARE_ACCOUNT_ID) || !hasValue(env.CLOUDFLARE_CONTAINERS_API_TOKEN)) {
    return undefined;
  }
  try {
    const response = await dependencies.fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/tokens/verify`,
      { headers: { Authorization: `Bearer ${env.CLOUDFLARE_CONTAINERS_API_TOKEN}` } },
    );
    if (!response.ok) {
      return undefined;
    }
    return cloudflareTokenIdentityResponseSchema.safeParse(await response.json()).data?.result;
  } catch {
    return undefined;
  }
}

async function validCloudflareRegistryPush(
  env: RunnerSetupValidationEnvironment,
  dependencies: RunnerSetupValidationDependencies,
): Promise<boolean> {
  if (!hasValue(env.CLOUDFLARE_ACCOUNT_ID) || !hasValue(env.CLOUDFLARE_CONTAINERS_API_TOKEN)) {
    return false;
  }
  try {
    const response = await dependencies.fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/containers/registries/registry.cloudflare.com/credentials`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${env.CLOUDFLARE_CONTAINERS_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expiration_minutes: 1, permissions: ["push"] }),
      },
    );
    if (!response.ok) {
      return false;
    }
    return registryCredentialsResponseSchema.safeParse(await response.json()).success;
  } catch {
    return false;
  }
}

async function validGitHubApp(
  env: RunnerSetupValidationEnvironment,
  dependencies: RunnerSetupValidationDependencies,
): Promise<boolean> {
  return (await githubAppStatus(env, { fetch: dependencies.fetch, now: () => Date.now() })).valid;
}

export function hasValidSetupAuthorization(request: Request, env: RunnerSetupValidationEnvironment): boolean {
  return (
    hasValue(env.RUNNER_SETUP_VALIDATION_TOKEN) &&
    request.headers.get("Authorization") === `Bearer ${env.RUNNER_SETUP_VALIDATION_TOKEN}`
  );
}

export async function validateRunnerSetupTokens(
  env: RunnerSetupValidationEnvironment,
  dependencies: RunnerSetupValidationDependencies = defaultDependencies,
): Promise<RunnerSetupTokenStatus> {
  const [cloudflareContainersToken, cloudflareRegistryPush, cloudflareResourceTagging, githubApp] = await Promise.all([
    validCloudflareContainersToken(env, dependencies),
    validCloudflareRegistryPush(env, dependencies),
    validCloudflareResourceTagging(env, dependencies),
    validGitHubApp(env, dependencies),
  ]);
  return {
    cloudflareContainersToken,
    cloudflareRegistryPush,
    cloudflareResourceTagging,
    githubApp,
    githubAppWebhookSecret: hasGitHubAppWebhookSecret(env),
    resourceTraceSigningKey: hasValue(env.RESOURCE_TRACE_SIGNING_KEY),
    runnerCacheSigningKey: hasValue(env.RUNNER_CACHE_SIGNING_KEY),
  };
}
import { z } from "zod";
