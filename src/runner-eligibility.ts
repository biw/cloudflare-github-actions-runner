import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import type { WorkerEnvironment } from "./environment";
import { githubInstallationAccessToken } from "./github-app";
import { githubRepositoryName, type GitHubRepositoryTarget } from "./github-repository";

const githubApiVersion = "2022-11-28";
const eligibilityCheckName = "Cloudflare runner eligibility";
const eligibilityCheckTitle = "Cloudflare runners require a private repository";
const eligibilityCheckDetailsUrl = "https://github.com/biw/cloudflare-github-actions-runner#private-repositories-only";
const githubCheckRequestTimeoutMs = 20_000;
const checkCreationLeaseMs = 5 * 60_000;
const checkStateRetentionMs = 30 * 24 * 60 * 60 * 1_000;

export type GitHubRepositoryVisibility = "private" | "public" | "internal";
export type RejectedRepositoryVisibility = Exclude<GitHubRepositoryVisibility, "private"> | "unverifiable";

export interface RunnerEligibilityInput {
  jobId: string;
  headSha: string;
  target: GitHubRepositoryTarget;
  installationId: number | null;
}

export type RunnerEligibilityResult =
  | { kind: "private" }
  | { kind: "rejected"; visibility: RejectedRepositoryVisibility; checkReported: boolean };

export interface RunnerEligibilityDependencies {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  now: () => number;
}

interface EligibilityCheckRow {
  [column: string]: ArrayBuffer | number | string | null;
  job_id: string;
  github_owner: string;
  github_repository: string;
  head_sha: string;
  check_run_id: number | null;
  creation_state: "idle" | "creating" | "ready";
  creation_started_at: number | null;
  updated_at: number;
}

interface EligibilityCheckOutput {
  title: string;
  summary: string;
}

interface EligibilityCheckBody {
  name: string;
  head_sha: string;
  status: string;
  conclusion: string;
  external_id: string;
  details_url: string;
  output: EligibilityCheckOutput;
}

const defaultDependencies: RunnerEligibilityDependencies = {
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
};

const nonEmptyStringSchema = z.string().trim().min(1);
const positiveIntegerSchema = z.number().int().positive();
const visibilitySchema = z.object({ visibility: z.enum(["private", "public", "internal"]) });
const checkRunSchema = z.object({ id: positiveIntegerSchema, external_id: z.string().nullish() });
const checkRunsSchema = z.object({ check_runs: z.array(checkRunSchema) });
const eligibilityInputSchema = z.object({
  jobId: nonEmptyStringSchema,
  headSha: nonEmptyStringSchema,
  target: z.object({ owner: nonEmptyStringSchema, repository: nonEmptyStringSchema }),
  installationId: positiveIntegerSchema.nullable(),
});

class GitHubEligibilityApiError extends Error {
  readonly operation: string;
  readonly requestId?: string;
  readonly status?: number;

  constructor(operation: string, response?: Response) {
    super(
      response === undefined
        ? `GitHub ${operation} request failed`
        : `GitHub ${operation} request failed with status ${response.status}`,
    );
    this.name = "GitHubEligibilityApiError";
    this.operation = operation;
    this.status = response?.status;
    this.requestId = response?.headers.get("X-GitHub-Request-Id") ?? undefined;
  }
}

function githubHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "cloudflare-github-actions-runner",
    "X-GitHub-Api-Version": githubApiVersion,
  };
}

function repositoryUrl(target: GitHubRepositoryTarget): string {
  return `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}`;
}

function checkExternalId(jobId: string): string {
  return `cloudflare-runner-eligibility:${jobId}`;
}

function checkSummary(target: GitHubRepositoryTarget, visibility: RejectedRepositoryVisibility): string {
  const repository = githubRepositoryName(target);
  const reason =
    visibility === "unverifiable"
      ? `${repository}'s current visibility could not be verified.`
      : `${repository} is ${visibility}.`;
  return (
    `Cloudflare runner did not start.\n\n${reason} ` +
    "cloudflare-github-actions-runner supports private repositories only. " +
    "Use another runs-on label or change the repository visibility to private."
  );
}

function checkBody(input: RunnerEligibilityInput, visibility: RejectedRepositoryVisibility): EligibilityCheckBody {
  return {
    name: eligibilityCheckName,
    head_sha: input.headSha,
    status: "completed",
    conclusion: "failure",
    external_id: checkExternalId(input.jobId),
    details_url: eligibilityCheckDetailsUrl,
    output: { title: eligibilityCheckTitle, summary: checkSummary(input.target, visibility) },
  };
}

function checkUpdateBody(
  input: RunnerEligibilityInput,
  visibility: RejectedRepositoryVisibility,
): Omit<EligibilityCheckBody, "head_sha"> {
  const body = checkBody(input, visibility);
  const { head_sha: _headSha, ...update } = body;
  return update;
}

function logEligibilityError(input: RunnerEligibilityInput, operation: string, error?: Error | string): void {
  const apiError = error instanceof GitHubEligibilityApiError ? error : undefined;
  console.error("Cloudflare runner eligibility check failed", {
    jobId: input.jobId,
    repository: githubRepositoryName(input.target),
    operation: apiError?.operation ?? operation,
    status: apiError?.status,
    requestId: apiError?.requestId,
    error: error instanceof Error ? error.message : error,
  });
}

export async function fetchGitHubRepositoryVisibility(
  target: GitHubRepositoryTarget,
  token: string,
  dependencies: RunnerEligibilityDependencies = defaultDependencies,
): Promise<GitHubRepositoryVisibility | undefined> {
  try {
    const response = await dependencies.fetch(repositoryUrl(target), {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(githubCheckRequestTimeoutMs),
    });
    if (!response.ok) {
      throw new GitHubEligibilityApiError("repository-visibility", response);
    }
    const parsed = visibilitySchema.safeParse(await response.json());
    return parsed.success ? parsed.data.visibility : undefined;
  } catch (error) {
    if (error instanceof GitHubEligibilityApiError) {
      throw error;
    }
    throw new GitHubEligibilityApiError("repository-visibility");
  }
}

async function findEligibilityCheck(
  input: RunnerEligibilityInput,
  token: string,
  appId: string,
  dependencies: RunnerEligibilityDependencies,
): Promise<number | undefined> {
  const externalId = checkExternalId(input.jobId);
  for (let page = 1; page <= 10; page += 1) {
    const query = new URLSearchParams({
      check_name: eligibilityCheckName,
      filter: "all",
      per_page: "100",
      page: String(page),
      app_id: appId,
    });
    // eslint-disable-next-line no-await-in-loop -- recovery must inspect each bounded page in order.
    const response = await dependencies.fetch(
      `${repositoryUrl(input.target)}/commits/${encodeURIComponent(input.headSha)}/check-runs?${query}`,
      { headers: githubHeaders(token), signal: AbortSignal.timeout(githubCheckRequestTimeoutMs) },
    );
    if (!response.ok) {
      throw new GitHubEligibilityApiError("eligibility-check-list", response);
    }
    // eslint-disable-next-line no-await-in-loop -- validate the page before deciding whether another is needed.
    const parsed = checkRunsSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new GitHubEligibilityApiError("eligibility-check-list-response");
    }
    const existing = parsed.data.check_runs.find((checkRun) => checkRun.external_id === externalId);
    if (existing !== undefined) {
      return existing.id;
    }
    if (parsed.data.check_runs.length < 100) {
      return undefined;
    }
  }
  return undefined;
}

async function createEligibilityCheck(
  input: RunnerEligibilityInput,
  visibility: RejectedRepositoryVisibility,
  token: string,
  dependencies: RunnerEligibilityDependencies,
): Promise<number> {
  const response = await dependencies.fetch(`${repositoryUrl(input.target)}/check-runs`, {
    method: "POST",
    headers: { ...githubHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(checkBody(input, visibility)),
    signal: AbortSignal.timeout(githubCheckRequestTimeoutMs),
  });
  if (!response.ok) {
    throw new GitHubEligibilityApiError("eligibility-check-create", response);
  }
  const parsed = checkRunSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new GitHubEligibilityApiError("eligibility-check-create-response");
  }
  return parsed.data.id;
}

export async function updateGitHubEligibilityCheck(
  input: RunnerEligibilityInput,
  visibility: RejectedRepositoryVisibility,
  token: string,
  checkRunId: number,
  dependencies: RunnerEligibilityDependencies,
): Promise<"not-found" | "updated"> {
  const response = await dependencies.fetch(`${repositoryUrl(input.target)}/check-runs/${checkRunId}`, {
    method: "PATCH",
    headers: { ...githubHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(checkUpdateBody(input, visibility)),
    signal: AbortSignal.timeout(githubCheckRequestTimeoutMs),
  });
  if (response.status === 404) {
    return "not-found";
  }
  if (!response.ok) {
    throw new GitHubEligibilityApiError("eligibility-check-update", response);
  }
  return "updated";
}

export async function createOrRecoverGitHubEligibilityCheck(
  input: RunnerEligibilityInput,
  visibility: RejectedRepositoryVisibility,
  token: string,
  appId: string,
  dependencies: RunnerEligibilityDependencies = defaultDependencies,
): Promise<number> {
  const existing = await findEligibilityCheck(input, token, appId, dependencies);
  if (existing === undefined) {
    return createEligibilityCheck(input, visibility, token, dependencies);
  }
  const update = await updateGitHubEligibilityCheck(input, visibility, token, existing, dependencies);
  return update === "updated" ? existing : createEligibilityCheck(input, visibility, token, dependencies);
}

export type EligibilityCheckReporter = (visibility: RejectedRepositoryVisibility) => Promise<boolean>;

export async function authorizeGitHubRepositoryWithToken(
  input: RunnerEligibilityInput,
  token: string,
  reportCheck: EligibilityCheckReporter,
  dependencies: RunnerEligibilityDependencies = defaultDependencies,
): Promise<RunnerEligibilityResult> {
  let visibility: GitHubRepositoryVisibility | undefined;
  try {
    visibility = await fetchGitHubRepositoryVisibility(input.target, token, dependencies);
  } catch (error) {
    logEligibilityError(input, "repository-visibility", error instanceof Error ? error : String(error));
  }
  if (visibility === "private") {
    return { kind: "private" };
  }

  const rejectedVisibility = visibility ?? "unverifiable";
  let checkReported = false;
  try {
    checkReported = await reportCheck(rejectedVisibility);
  } catch (error) {
    logEligibilityError(input, "eligibility-check-report", error instanceof Error ? error : String(error));
  }
  return { kind: "rejected", visibility: rejectedVisibility, checkReported };
}

/**
 * One coordinator exists per GitHub job. SQLite leases serialize Check
 * creation without holding a Durable Object concurrency gate across GitHub
 * network I/O. A recovery first searches by external ID before creating.
 */
export class RunnerEligibilityCheck extends DurableObject<WorkerEnvironment> {
  private activeCheckReport?: Promise<boolean>;

  constructor(ctx: DurableObjectState, env: WorkerEnvironment) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS eligibility_check (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          job_id TEXT NOT NULL,
          github_owner TEXT NOT NULL,
          github_repository TEXT NOT NULL,
          head_sha TEXT NOT NULL,
          check_run_id INTEGER,
          creation_state TEXT NOT NULL,
          creation_started_at INTEGER,
          updated_at INTEGER NOT NULL
        )
      `);
    });
  }

  private row(): EligibilityCheckRow | undefined {
    return this.ctx.storage.sql
      .exec<EligibilityCheckRow>("SELECT * FROM eligibility_check WHERE singleton = 1")
      .toArray()[0];
  }

  private identityMatches(row: EligibilityCheckRow, input: RunnerEligibilityInput): boolean {
    return (
      row.job_id === input.jobId &&
      row.github_owner.toLowerCase() === input.target.owner.toLowerCase() &&
      row.github_repository.toLowerCase() === input.target.repository.toLowerCase() &&
      row.head_sha === input.headSha
    );
  }

  private initializeCheckState(input: RunnerEligibilityInput, timestamp: number): EligibilityCheckRow | undefined {
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO eligibility_check
       (singleton, job_id, github_owner, github_repository, head_sha, check_run_id, creation_state, creation_started_at, updated_at)
       VALUES (1, ?, ?, ?, ?, NULL, 'idle', NULL, ?)`,
      input.jobId,
      input.target.owner,
      input.target.repository,
      input.headSha,
      timestamp,
    );
    const row = this.row();
    if (row !== undefined && !this.identityMatches(row, input)) {
      logEligibilityError(input, "durable-identity-mismatch");
      return undefined;
    }
    return row;
  }

  private claimCreation(timestamp: number): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ singleton: number }>(
          `UPDATE eligibility_check
           SET creation_state = 'creating', creation_started_at = ?, updated_at = ?
           WHERE singleton = 1 AND check_run_id IS NULL
             AND (creation_state = 'idle' OR creation_started_at IS NULL OR creation_started_at <= ?)
           RETURNING singleton`,
          timestamp,
          timestamp,
          timestamp - checkCreationLeaseMs,
        )
        .toArray().length === 1
    );
  }

  private resetCreation(timestamp: number): void {
    this.ctx.storage.sql.exec(
      `UPDATE eligibility_check
       SET creation_state = 'idle', creation_started_at = NULL, updated_at = ?
       WHERE singleton = 1 AND check_run_id IS NULL AND creation_started_at = ?`,
      defaultDependencies.now(),
      timestamp,
    );
  }

  private storeCheckRun(checkRunId: number, timestamp: number): void {
    this.ctx.storage.sql.exec(
      `UPDATE eligibility_check
       SET check_run_id = ?, creation_state = 'ready', creation_started_at = NULL, updated_at = ?
       WHERE singleton = 1 AND creation_started_at = ?`,
      checkRunId,
      defaultDependencies.now(),
      timestamp,
    );
  }

  private clearMissingCheckRun(checkRunId: number): void {
    this.ctx.storage.sql.exec(
      `UPDATE eligibility_check
       SET check_run_id = NULL, creation_state = 'idle', creation_started_at = NULL, updated_at = ?
       WHERE singleton = 1 AND check_run_id = ?`,
      defaultDependencies.now(),
      checkRunId,
    );
  }

  private async reportCheckOnce(
    input: RunnerEligibilityInput,
    visibility: RejectedRepositoryVisibility,
    token: string,
  ): Promise<boolean> {
    const timestamp = defaultDependencies.now();
    let state = this.initializeCheckState(input, timestamp);
    if (state === undefined) {
      return false;
    }

    if (state.check_run_id !== null) {
      try {
        const update = await updateGitHubEligibilityCheck(
          input,
          visibility,
          token,
          state.check_run_id,
          defaultDependencies,
        );
        if (update === "updated") {
          await this.ctx.storage.setAlarm(timestamp + checkStateRetentionMs);
          return true;
        }
        this.clearMissingCheckRun(state.check_run_id);
        state = this.row();
      } catch (error) {
        logEligibilityError(input, "eligibility-check-update", error instanceof Error ? error : String(error));
        return false;
      }
    }

    if (state === undefined || !this.claimCreation(timestamp)) {
      return false;
    }

    try {
      const checkRunId = await createOrRecoverGitHubEligibilityCheck(
        input,
        visibility,
        token,
        nonEmptyStringSchema.parse(this.env.GITHUB_APP_ID),
        defaultDependencies,
      );
      this.storeCheckRun(checkRunId, timestamp);
      await this.ctx.storage.setAlarm(timestamp + checkStateRetentionMs);
      return true;
    } catch (error) {
      this.resetCreation(timestamp);
      logEligibilityError(input, "eligibility-check-report", error instanceof Error ? error : String(error));
      return false;
    }
  }

  private async reportCheck(
    input: RunnerEligibilityInput,
    visibility: RejectedRepositoryVisibility,
    token: string,
  ): Promise<boolean> {
    if (this.activeCheckReport !== undefined) {
      return this.activeCheckReport;
    }

    const operation = this.reportCheckOnce(input, visibility, token);
    this.activeCheckReport = operation;
    try {
      return await operation;
    } finally {
      if (this.activeCheckReport === operation) {
        this.activeCheckReport = undefined;
      }
    }
  }

  async authorize(inputValue: RunnerEligibilityInput): Promise<RunnerEligibilityResult> {
    const parsedInput = eligibilityInputSchema.safeParse(inputValue);
    if (!parsedInput.success) {
      const fallbackInput: RunnerEligibilityInput = {
        jobId: nonEmptyStringSchema.safeParse(inputValue.jobId).data ?? "unknown",
        headSha: nonEmptyStringSchema.safeParse(inputValue.headSha).data ?? "unknown",
        target: inputValue.target,
        installationId: null,
      };
      logEligibilityError(fallbackInput, "invalid-eligibility-input");
      return { kind: "rejected", visibility: "unverifiable", checkReported: false };
    }
    const input = parsedInput.data;
    const timestamp = defaultDependencies.now();
    if (this.initializeCheckState(input, timestamp) === undefined) {
      return { kind: "rejected", visibility: "unverifiable", checkReported: false };
    }
    await this.ctx.storage.setAlarm(timestamp + checkStateRetentionMs);

    if (input.installationId === null) {
      logEligibilityError(input, "missing-installation-id");
      return { kind: "rejected", visibility: "unverifiable", checkReported: false };
    }

    const token = await githubInstallationAccessToken(this.env, input.installationId, defaultDependencies);
    if (token === undefined) {
      logEligibilityError(input, "installation-token");
      return { kind: "rejected", visibility: "unverifiable", checkReported: false };
    }

    return authorizeGitHubRepositoryWithToken(
      input,
      token,
      (visibility) => this.reportCheck(input, visibility, token),
      defaultDependencies,
    );
  }

  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM eligibility_check");
  }
}

export async function runnerEligibilityFor(
  env: WorkerEnvironment,
  input: RunnerEligibilityInput,
): Promise<RunnerEligibilityResult> {
  try {
    return await env.RUNNER_ELIGIBILITY_CHECK.getByName(input.jobId).authorize(input);
  } catch (error) {
    logEligibilityError(input, "durable-object", error instanceof Error ? error : String(error));
    return { kind: "rejected", visibility: "unverifiable", checkReported: false };
  }
}
