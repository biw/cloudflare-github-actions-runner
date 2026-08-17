import { z } from "zod";

import { parseGitHubRepositoryTarget, type GitHubRepositoryTarget } from "./github-repository";
import { hasCloudflareRunnerIntent, selectRunnerProfile, type RunnerProfile } from "./runner-profiles";

export interface CloudflareQueuedWebhookDecision {
  kind: "cloudflare-job-queued";
  jobId: string;
  headSha: string;
  labels: string[];
  /** Used to resolve GitHub-compatible R2 cache visibility for this run. */
  workflowRunId?: number;
  defaultBranch?: string;
  installationId?: number;
}

export type AuthorizedQueuedWebhookDecision =
  | {
      kind: "invalid-runner";
      jobId: string;
      headSha: string;
      runnerName: string;
      labels: string[];
      title: string;
      errors: readonly string[];
      installationId?: number;
    }
  | {
      kind: "job-queued";
      jobId: string;
      headSha: string;
      runnerName: string;
      profile: RunnerProfile;
      /** Used to resolve GitHub-compatible R2 cache visibility for this run. */
      workflowRunId?: number;
      defaultBranch?: string;
      installationId?: number;
    };

export type WebhookDecision =
  | { kind: "ping" }
  | { kind: "ignored" }
  | { kind: "invalid" }
  | CloudflareQueuedWebhookDecision
  | AuthorizedQueuedWebhookDecision
  | {
      kind: "job-started";
      jobId: string;
      runnerName: string;
      runnerId?: number;
      profile: RunnerProfile;
      installationId?: number;
    }
  | { kind: "job-completed"; jobId: string };

const positiveIntegerSchema = z.number().int().positive();
const optionalPositiveIntegerSchema = positiveIntegerSchema.optional().catch(undefined);
const optionalNonEmptyStringSchema = z.string().trim().min(1).optional().catch(undefined);
const repositorySchema = z.object({
  full_name: z.string(),
  default_branch: optionalNonEmptyStringSchema,
});
const repositoryPayloadSchema = z.object({ repository: repositorySchema });
const pushPayloadSchema = repositoryPayloadSchema.extend({ ref: z.string() });
const workflowJobPayloadSchema = z.object({
  action: z.string().optional().catch(undefined),
  repository: repositorySchema.optional().catch(undefined),
  workflow_job: z
    .object({
      id: optionalPositiveIntegerSchema,
      run_id: optionalPositiveIntegerSchema,
      head_sha: optionalNonEmptyStringSchema,
      labels: z.array(z.json()).optional().catch(undefined),
      runner_id: optionalPositiveIntegerSchema,
      runner_name: optionalNonEmptyStringSchema,
    })
    .optional()
    .catch(undefined),
  installation: z.object({ id: optionalPositiveIntegerSchema }).optional().catch(undefined),
});

type WorkflowJobPayload = z.infer<typeof workflowJobPayloadSchema>;

function parseJsonBody(body: string): z.core.util.JSONType | undefined {
  try {
    const parsed = z.json().safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function githubRepositoryFromWebhook(body: string): GitHubRepositoryTarget | undefined {
  const parsed = repositoryPayloadSchema.safeParse(parseJsonBody(body));
  return parsed.success ? parseGitHubRepositoryTarget(parsed.data.repository.full_name) : undefined;
}

export function githubPushFromWebhook(body: string): { repository: GitHubRepositoryTarget; ref: string } | undefined {
  const parsed = pushPayloadSchema.safeParse(parseJsonBody(body));
  if (!parsed.success) {
    return undefined;
  }
  const repository = parseGitHubRepositoryTarget(parsed.data.repository.full_name);
  return repository === undefined ? undefined : { repository, ref: parsed.data.ref };
}

function installationId(payload: WorkflowJobPayload): number | undefined {
  return payload.installation?.id;
}

function runnerId(payload: WorkflowJobPayload): number | undefined {
  return payload.workflow_job?.runner_id;
}

function runnerName(payload: WorkflowJobPayload): string | undefined {
  return payload.workflow_job?.runner_name;
}

function stringLabels(value: readonly z.core.util.JSONType[]): string[] {
  return value.flatMap((label) => {
    const parsed = z.string().safeParse(label);
    return parsed.success ? [parsed.data] : [];
  });
}

function workflowRunId(payload: WorkflowJobPayload): number | undefined {
  return payload.workflow_job?.run_id;
}

function defaultBranch(payload: WorkflowJobPayload): string | undefined {
  return payload.repository?.default_branch;
}

export function classifyAuthorizedQueuedWebhook(
  decision: CloudflareQueuedWebhookDecision,
): AuthorizedQueuedWebhookDecision {
  const profileSelection = selectRunnerProfile(decision.labels);
  if (profileSelection.kind === "conflicting" || profileSelection.kind === "invalid") {
    return {
      kind: "invalid-runner",
      jobId: decision.jobId,
      headSha: decision.headSha,
      runnerName: `cf-validation-job-${decision.jobId}`,
      labels: decision.labels,
      title:
        profileSelection.kind === "invalid"
          ? "Invalid Cloudflare custom runner"
          : "Invalid Cloudflare runner selection",
      errors: profileSelection.errors,
      installationId: decision.installationId,
    };
  }
  if (profileSelection.kind === "none") {
    return {
      kind: "invalid-runner",
      jobId: decision.jobId,
      headSha: decision.headSha,
      runnerName: `cf-validation-job-${decision.jobId}`,
      labels: decision.labels,
      title: "Invalid Cloudflare runner selection",
      errors: ["Select a documented Cloudflare runner profile."],
      installationId: decision.installationId,
    };
  }
  return {
    kind: "job-queued",
    jobId: decision.jobId,
    headSha: decision.headSha,
    runnerName: `cf-${profileSelection.profile.key}-job-${decision.jobId}`,
    profile: profileSelection.profile,
    workflowRunId: decision.workflowRunId,
    defaultBranch: decision.defaultBranch,
    installationId: decision.installationId,
  };
}

function hexToBytes(hex: string): ArrayBuffer | undefined {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    return undefined;
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
  return bytes.buffer;
}

export async function hasValidGitHubSignature(
  body: ArrayBuffer,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=") || secret.length === 0) {
    return false;
  }

  const receivedSignature = hexToBytes(signatureHeader.slice("sha256=".length));
  if (receivedSignature === undefined) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  return crypto.subtle.verify("HMAC", key, receivedSignature, body);
}

export function classifyGitHubWebhookIntent(
  event: string | null,
  body: string,
  expectedRepository: string,
): WebhookDecision {
  if (event === "ping") {
    return { kind: "ping" };
  }

  if (event !== "workflow_job") {
    return { kind: "ignored" };
  }

  const parsedPayload = workflowJobPayloadSchema.safeParse(parseJsonBody(body));
  if (!parsedPayload.success) {
    return { kind: "invalid" };
  }
  const payload = parsedPayload.data;

  if (payload.repository?.full_name.toLowerCase() !== expectedRepository.toLowerCase()) {
    return { kind: "ignored" };
  }

  const jobId = payload.workflow_job?.id;
  if (jobId === undefined) {
    return { kind: "invalid" };
  }

  const labels = payload.workflow_job?.labels;
  if (!Array.isArray(labels)) {
    return { kind: "ignored" };
  }

  if (!hasCloudflareRunnerIntent(labels)) {
    return { kind: "ignored" };
  }

  if (payload.action !== "queued" && payload.action !== "in_progress" && payload.action !== "completed") {
    return { kind: "ignored" };
  }

  if (payload.action === "queued") {
    const headSha = payload.workflow_job?.head_sha;
    if (headSha === undefined) {
      return { kind: "invalid" };
    }
    return {
      kind: "cloudflare-job-queued",
      jobId: String(jobId),
      headSha,
      labels: stringLabels(labels),
      workflowRunId: workflowRunId(payload),
      defaultBranch: defaultBranch(payload),
      installationId: installationId(payload),
    };
  }

  const profileSelection = selectRunnerProfile(labels);
  if (profileSelection.kind === "none") {
    return { kind: "ignored" };
  }
  if (profileSelection.kind === "conflicting" || profileSelection.kind === "invalid") {
    // A private diagnostic runner handles the queued delivery. Ignore the
    // subsequent assignment delivery so it cannot create a second runner.
    return { kind: "ignored" };
  }

  const assignedRunnerName = runnerName(payload);
  if (assignedRunnerName === undefined) {
    return { kind: "ignored" };
  }
  if (payload.action === "completed") {
    return { kind: "job-completed", jobId: String(jobId) };
  }
  return {
    kind: "job-started",
    jobId: String(jobId),
    runnerName: assignedRunnerName,
    runnerId: runnerId(payload),
    profile: profileSelection.profile,
    installationId: installationId(payload),
  };
}

/** Classify a webhook after assuming private-repository authorization. */
export function classifyGitHubWebhook(event: string | null, body: string, expectedRepository: string): WebhookDecision {
  const decision = classifyGitHubWebhookIntent(event, body, expectedRepository);
  return decision.kind === "cloudflare-job-queued" ? classifyAuthorizedQueuedWebhook(decision) : decision;
}
