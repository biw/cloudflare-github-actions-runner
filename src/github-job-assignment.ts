import { z } from "zod";

import { githubTokenForRunner, type GitHubAppDependencies, type GitHubAppEnvironment } from "./github-app";
import {
  githubRunnerTokenFor,
  type GitHubDynamicSecretEnvironment,
  type GitHubRepositoryTarget,
} from "./github-repository";
import { githubHeaders } from "./provision";

const githubJobDetailSchema = z.object({
  status: z.string(),
  runner_id: z.number().int().nonnegative().nullable(),
  runner_name: z.string().nullable(),
});
const workflowJobsSchema = z.object({
  total_count: z.number().int().nonnegative(),
  jobs: z.array(githubJobDetailSchema.extend({ id: z.number().int().positive() })),
});

export type GitHubJobDetail = z.infer<typeof githubJobDetailSchema>;
export type GitHubWorkflowJobs = z.infer<typeof workflowJobsSchema>;

const dependencies: GitHubAppDependencies = {
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
};

/** One lookup sweep reuses each installation credential across all its requests. */
export class GitHubJobAssignmentClient {
  private readonly tokens = new Map<number | null, string | undefined>();

  constructor(
    private readonly env: GitHubAppEnvironment & GitHubDynamicSecretEnvironment,
    private readonly target: GitHubRepositoryTarget,
    private readonly deps: GitHubAppDependencies = dependencies,
  ) {}

  private async request(
    path: string,
    installationId: number | null,
    signal: AbortSignal,
  ): Promise<Response | undefined> {
    try {
      if (signal.aborted) {
        return undefined;
      }
      if (!this.tokens.has(installationId)) {
        const token = await githubTokenForRunner(
          this.env,
          this.target,
          installationId,
          (target) => githubRunnerTokenFor(this.env, target),
          {
            fetch: (input, init) => this.deps.fetch(input, { ...init, signal }),
            now: this.deps.now,
          },
        );
        this.tokens.set(installationId, token);
      }
      const token = this.tokens.get(installationId);
      if (token === undefined || signal.aborted) {
        return undefined;
      }
      const response = await this.deps.fetch(
        `https://api.github.com/repos/${encodeURIComponent(this.target.owner)}/${encodeURIComponent(this.target.repository)}/actions/${path}`,
        {
          headers: githubHeaders(token),
          signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
        },
      );
      if (!response.ok) {
        console.error("GitHub assignment lookup failed", { path, status: response.status });
        await response.body?.cancel();
        return undefined;
      }
      return response;
    } catch (error) {
      console.error("GitHub assignment lookup failed", {
        path,
        reason: signal.aborted ? "deadline" : error instanceof Error ? error.name : "request-error",
      });
      return undefined;
    }
  }

  async jobDetail(
    jobId: string,
    installationId: number | null,
    signal: AbortSignal,
  ): Promise<GitHubJobDetail | undefined> {
    const response = await this.request(`jobs/${encodeURIComponent(jobId)}`, installationId, signal);
    if (response === undefined) {
      return undefined;
    }
    try {
      const parsed = githubJobDetailSchema.safeParse(await response.json());
      if (parsed.success) {
        return parsed.data;
      }
    } catch {
      // Invalid JSON and unexpected response shapes both leave the claim unresolved.
    }
    console.error("GitHub assignment lookup returned an invalid job", { jobId });
    return undefined;
  }

  async workflowJobs(
    runId: string,
    page: number,
    installationId: number | null,
    signal: AbortSignal,
  ): Promise<GitHubWorkflowJobs | undefined> {
    const response = await this.request(
      `runs/${encodeURIComponent(runId)}/jobs?filter=latest&per_page=100&page=${page}`,
      installationId,
      signal,
    );
    if (response === undefined) {
      return undefined;
    }
    try {
      const parsed = workflowJobsSchema.safeParse(await response.json());
      if (parsed.success) {
        return parsed.data;
      }
    } catch {
      // Never accept an assignment from a partial or malformed response.
    }
    console.error("GitHub assignment lookup returned invalid workflow jobs", { runId, page });
    return undefined;
  }
}
