import type { GitHubRunnerEnvironment } from "./provision";
import type { GitHubAppEnvironment } from "./github-app";
import type { GitHubCredentialEnvironment, GitHubDynamicSecretEnvironment } from "./github-repository";

export interface WorkerSecrets {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_CONTAINERS_API_TOKEN: string;
  /** GitHub App authentication and webhook credentials. */
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_WEBHOOK_SECRET: string;
  /** Candidate credentials used only while interactively replacing an App. */
  PENDING_GITHUB_APP_ID?: string;
  PENDING_GITHUB_APP_PRIVATE_KEY?: string;
  PENDING_GITHUB_APP_WEBHOOK_SECRET?: string;
  RUNNER_SETUP_VALIDATION_TOKEN: string;
  /** HMAC key for the short-lived, runner-scoped trace ingestion capability. */
  RESOURCE_TRACE_SIGNING_KEY: string;
  /** HMAC key for short-lived, repository-scoped R2 cache capabilities. */
  RUNNER_CACHE_SIGNING_KEY: string;
}

export type WorkerEnvironment = Env &
  GitHubRunnerEnvironment &
  GitHubAppEnvironment &
  GitHubCredentialEnvironment &
  GitHubDynamicSecretEnvironment &
  WorkerSecrets & {
    RUNNER_INSTALLATION_ID: string;
    RUNNER_RESOURCE_MANIFEST: string;
  };
