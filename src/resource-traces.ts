import { z } from "zod";

import type { GitHubRepositoryTarget } from "./github-repository";

const traceTokenLifetimeMs = 30 * 60 * 1_000;
const maxSamplesPerRequest = 15;

export interface ResourceTraceEnvironment {
  RESOURCE_METRICS: D1Database;
  RESOURCE_TRACE_SIGNING_KEY: string;
}

export interface ResourceTraceClaim {
  version: 1;
  runnerName: string;
  jobId: string;
  repository: string;
  expiresAt: number;
}

export interface ResourceTraceContainerConfiguration {
  endpoint: string;
  authorization: string;
}

export interface ResourceTraceAssignment {
  runnerName: string;
  jobId: string;
  repository: string;
}

const nonEmptyStringSchema = z.string().trim().min(1);
const safeIntegerSchema = z.number().int();
const safeNonNegativeIntegerSchema = safeIntegerSchema.nonnegative();
const phaseSchema = z
  .string()
  .min(1)
  .max(120)
  .refine((value) =>
    [...value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    }),
  );
const timestampSchema = z
  .string()
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)));
const resourceTraceClaimSchema = z.object({
  version: z.literal(1),
  runnerName: nonEmptyStringSchema,
  jobId: nonEmptyStringSchema,
  repository: nonEmptyStringSchema,
  expiresAt: safeIntegerSchema.positive(),
});
const resourceTraceSampleSchema = z.object({
  timestamp: timestampSchema,
  elapsedSeconds: safeNonNegativeIntegerSchema,
  intervalSeconds: safeNonNegativeIntegerSchema,
  phase: phaseSchema,
  cpuTotalUsec: safeNonNegativeIntegerSchema,
  cpuDeltaUsec: safeNonNegativeIntegerSchema,
  cpuCoresAvg: z.number().finite().nonnegative(),
  memoryCurrentBytes: safeNonNegativeIntegerSchema,
  memoryPeakBytes: safeNonNegativeIntegerSchema,
  rootDiskUsedBytes: safeNonNegativeIntegerSchema,
  rootDiskDeltaBytes: safeIntegerSchema,
});
const resourceTracePayloadSchema = z
  .object({ samples: z.array(resourceTraceSampleSchema).min(1).max(maxSamplesPerRequest) })
  .refine((payload) => {
    const elapsedSeconds = new Set(payload.samples.map((sample) => sample.elapsedSeconds));
    return elapsedSeconds.size === payload.samples.length;
  });

type ResourceTraceSample = z.infer<typeof resourceTraceSampleSchema>;
type ResourceTracePayload = z.infer<typeof resourceTracePayloadSchema>;

function hasValue(value: string): boolean {
  return value.trim().length > 0;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    return undefined;
  }
  try {
    const decoded = atob(
      value
        .replaceAll("-", "+")
        .replaceAll("_", "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "="),
    );
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

async function hmac(secret: string, payload: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, byteBuffer(payload)));
}

async function hasValidSignature(secret: string, payload: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, byteBuffer(signature), byteBuffer(payload));
}

function byteBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

export async function createResourceTraceAuthorization(
  secret: string,
  input: Omit<ResourceTraceClaim, "version" | "expiresAt">,
  now = Date.now(),
): Promise<string> {
  if (!hasValue(secret)) {
    throw new Error("RESOURCE_TRACE_SIGNING_KEY is not configured");
  }
  const claim: ResourceTraceClaim = { ...input, version: 1, expiresAt: now + traceTokenLifetimeMs };
  const payload = new TextEncoder().encode(JSON.stringify(claim));
  return `${encodeBase64Url(payload)}.${encodeBase64Url(await hmac(secret, payload))}`;
}

export async function verifyResourceTraceAuthorization(
  secret: string,
  authorization: string | null,
  now = Date.now(),
): Promise<ResourceTraceClaim | undefined> {
  if (!hasValue(secret) || authorization === null || !authorization.startsWith("Bearer ")) {
    return undefined;
  }
  const [encodedClaim, encodedSignature, extraPart] = authorization.slice("Bearer ".length).split(".");
  if (encodedClaim === undefined || encodedSignature === undefined || extraPart !== undefined) {
    return undefined;
  }
  const payload = decodeBase64Url(encodedClaim);
  const signature = decodeBase64Url(encodedSignature);
  if (payload === undefined || signature === undefined || !(await hasValidSignature(secret, payload, signature))) {
    return undefined;
  }
  try {
    const claim = resourceTraceClaimSchema.safeParse(JSON.parse(new TextDecoder().decode(payload)));
    return claim.success && claim.data.expiresAt > now ? claim.data : undefined;
  } catch {
    return undefined;
  }
}

export async function createResourceTraceContainerConfiguration(
  env: Pick<ResourceTraceEnvironment, "RESOURCE_TRACE_SIGNING_KEY">,
  input: {
    workerOrigin: string;
    runnerName: string;
    jobId: string;
    target: GitHubRepositoryTarget;
  },
): Promise<ResourceTraceContainerConfiguration> {
  const workerUrl = new URL(input.workerOrigin);
  if (workerUrl.protocol !== "https:" || workerUrl.username !== "" || workerUrl.password !== "") {
    throw new Error("Resource trace endpoint must use an HTTPS Worker origin");
  }
  return {
    endpoint: new URL("/v1/resource-traces", workerUrl).toString(),
    authorization: await createResourceTraceAuthorization(env.RESOURCE_TRACE_SIGNING_KEY, {
      runnerName: input.runnerName,
      jobId: input.jobId,
      repository: `${input.target.owner}/${input.target.repository}`,
    }),
  };
}

export function parseResourceTracePayload(value: z.core.util.JSONType): ResourceTracePayload | undefined {
  const payload = resourceTracePayloadSchema.safeParse(value);
  return payload.success ? payload.data : undefined;
}

export async function persistResourceTraceSamples(
  env: Pick<ResourceTraceEnvironment, "RESOURCE_METRICS">,
  claim: ResourceTraceClaim,
  samples: readonly ResourceTraceSample[],
  receivedAt = Date.now(),
): Promise<void> {
  const assignment = await env.RESOURCE_METRICS.prepare(
    "SELECT job_id, repository FROM resource_trace_assignments WHERE runner_name = ?",
  )
    .bind(claim.runnerName)
    .first<{ job_id: string; repository: string }>();
  const jobId = assignment?.job_id ?? claim.jobId;
  const repository = assignment?.repository ?? claim.repository;
  const statement = env.RESOURCE_METRICS.prepare(
    `INSERT OR IGNORE INTO resource_trace_samples
     (runner_name, job_id, repository, sample_elapsed_seconds, sample_timestamp, interval_seconds, phase,
      cpu_total_usec, cpu_delta_usec, cpu_cores_avg, memory_current_bytes, memory_peak_bytes,
      root_disk_used_bytes, root_disk_delta_bytes, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await env.RESOURCE_METRICS.batch(
    samples.map((sample) =>
      statement.bind(
        claim.runnerName,
        jobId,
        repository,
        sample.elapsedSeconds,
        sample.timestamp,
        sample.intervalSeconds,
        sample.phase,
        sample.cpuTotalUsec,
        sample.cpuDeltaUsec,
        sample.cpuCoresAvg,
        sample.memoryCurrentBytes,
        sample.memoryPeakBytes,
        sample.rootDiskUsedBytes,
        sample.rootDiskDeltaBytes,
        receivedAt,
      ),
    ),
  );
}

/**
 * The signed trace capability identifies the Container's original JIT
 * configuration. GitHub can assign that JIT runner to a different compatible
 * queued job, so retain the authoritative `in_progress` assignment in D1 and
 * attribute every later sample to the job that actually ran.
 */
export async function assignResourceTraceRunner(
  env: Pick<ResourceTraceEnvironment, "RESOURCE_METRICS">,
  assignment: ResourceTraceAssignment,
  assignedAt = Date.now(),
): Promise<void> {
  await env.RESOURCE_METRICS.prepare(
    `INSERT INTO resource_trace_assignments (runner_name, job_id, repository, assigned_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(runner_name) DO UPDATE SET
       job_id = excluded.job_id,
       repository = excluded.repository,
       assigned_at = excluded.assigned_at`,
  )
    .bind(assignment.runnerName, assignment.jobId, assignment.repository, assignedAt)
    .run();
}
