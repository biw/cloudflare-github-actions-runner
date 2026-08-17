import { z } from "zod";

import type { GitHubRepositoryTarget } from "./github-repository";

const runnerCacheTokenLifetimeMs = 30 * 60 * 1_000;
const cacheKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u;
const actionCacheTokenLifetimeMs = 30 * 60 * 1_000;

/** Defaults used by `pnpm run setup` for the optional, private R2 cache. */
export const defaultRunnerCacheBucketName = "cloudflare-github-actions-runner-cache";
export const defaultRunnerCacheMaxBytes = 100_000_000_000;
export const defaultRunnerCachePrefix = "cloudflare-github-actions-runner";

export interface RunnerCacheEnvironment {
  RUNNER_CACHE: R2Bucket;
  RUNNER_CACHE_SIGNING_KEY: string;
  RUNNER_CACHE_ENABLED?: string;
  RUNNER_CACHE_MAX_BYTES?: string;
  RUNNER_CACHE_PREFIX?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  RUNNER_CACHE_QUOTA?: RunnerCacheQuotaNamespace;
}

export interface CacheQuotaLegacyRecord {
  objectKey: string;
  sizeBytes: number;
  createdAt: number;
}

export interface CacheQuotaLegacyRecordResult {
  retained: boolean;
}

export interface ActionCacheManifest {
  entryId: string;
  cacheKey: string;
  cacheVersion: string;
  objectKey: string;
  createdAt: number;
}

export interface CacheQuotaActionCommit {
  manifestKey: string;
  manifest: ActionCacheManifest;
  sizeBytes: number;
  customMetadata: Record<string, string>;
}

export type CacheQuotaActionCommitResult =
  | { kind: "stored" }
  | { kind: "already-exists" }
  | { kind: "too-large"; maximumBytes: number };

export interface RunnerCacheQuotaStub {
  recordLegacyCache(input: CacheQuotaLegacyRecord): Promise<CacheQuotaLegacyRecordResult>;
  commitActionCache(input: CacheQuotaActionCommit): Promise<CacheQuotaActionCommitResult>;
}

export interface RunnerCacheQuotaNamespace {
  getByName(name: string): RunnerCacheQuotaStub;
}

export interface RunnerCacheClaim {
  version: 1;
  runnerName: string;
  jobId: string;
  repository: string;
  scope: string;
  fallbackScope?: string;
  expiresAt: number;
}

export interface RunnerCacheContainerConfiguration {
  endpoint: string;
  authorization: string;
}

export interface RunnerCacheAssignment {
  workerOrigin: string;
  runnerName: string;
  jobId: string;
  target: GitHubRepositoryTarget;
  cacheScope: RunnerCacheScope;
}

export interface RunnerCacheScope {
  scope: string;
  fallbackScope?: string;
  writeAllowed: boolean;
}

export interface AssignedRunnerCacheScope {
  /** The GitHub job GitHub actually assigned to this one-job JIT runner. */
  jobId: string;
  cacheScope: RunnerCacheScope;
}

export interface RunnerCacheWriteAuthorizer {
  /**
   * Resolves the cache scope from GitHub's authoritative runner assignment.
   * JIT runners are eligible for any compatible queued job, so the job that
   * caused a runner to be provisioned is not necessarily the one it executes.
   */
  cacheAssignment?(runnerName: string, repository: string): Promise<AssignedRunnerCacheScope | undefined>;
  cacheScope?(runnerName: string, repository: string, jobId: string): Promise<RunnerCacheScope | undefined>;
  /** @deprecated Kept temporarily for direct handler consumers upgrading to scoped access. */
  canWriteCache?(runnerName: string, repository: string): Promise<boolean>;
}

interface ActionCacheSession {
  version: 1;
  kind: "download" | "upload";
  runnerName: string;
  jobId: string;
  repository: string;
  scope: string;
  fallbackScope?: string;
  cacheKey: string;
  cacheVersion: string;
  objectKey: string;
  uploadId?: string;
  expiresAt: number;
}

type UploadActionCacheSession = ActionCacheSession & { kind: "upload"; uploadId: string };

interface ActionCacheLookupRequest {
  key: string;
  version: string;
  restoreKeys: string[];
}

const nonEmptyStringSchema = z.string().trim().min(1);
const runnerCacheScopeSchema = z
  .string()
  .refine(
    (value) =>
      /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/u.test(value) ||
      /^refs\/pull\/[1-9][0-9]*\/merge$/u.test(value),
  );
const actionCacheValueSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      ![...value].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 31 || code === 127;
      }),
  );
const runnerCacheClaimSchema: z.ZodType<RunnerCacheClaim> = z.object({
  version: z.literal(1),
  runnerName: nonEmptyStringSchema,
  jobId: nonEmptyStringSchema,
  repository: nonEmptyStringSchema,
  scope: runnerCacheScopeSchema,
  fallbackScope: runnerCacheScopeSchema.optional(),
  expiresAt: z.number().int().positive(),
});
const actionCacheSessionSchema: z.ZodType<ActionCacheSession> = z.object({
  version: z.literal(1),
  kind: z.enum(["download", "upload"]),
  runnerName: nonEmptyStringSchema,
  jobId: nonEmptyStringSchema,
  repository: nonEmptyStringSchema,
  scope: runnerCacheScopeSchema,
  fallbackScope: runnerCacheScopeSchema.optional(),
  cacheKey: actionCacheValueSchema,
  cacheVersion: actionCacheValueSchema,
  objectKey: nonEmptyStringSchema,
  uploadId: nonEmptyStringSchema.optional(),
  expiresAt: z.number().int().positive(),
});
const actionCacheManifestSchema: z.ZodType<ActionCacheManifest> = z.object({
  entryId: nonEmptyStringSchema,
  cacheKey: actionCacheValueSchema,
  cacheVersion: actionCacheValueSchema,
  objectKey: nonEmptyStringSchema,
  createdAt: z.number().int().positive(),
});
const actionCacheRequestSchema: z.ZodType<ActionCacheLookupRequest> = z.object({
  key: actionCacheValueSchema,
  version: actionCacheValueSchema,
  restoreKeys: z.array(actionCacheValueSchema).max(9).default([]),
});
const completedPartsPayloadSchema = z.object({
  parts: z
    .array(
      z.object({
        blockId: nonEmptyStringSchema,
        partNumber: z.number().int().positive(),
        etag: nonEmptyStringSchema,
      }),
    )
    .min(1)
    .max(10_000),
});
const actionCacheFinalizeSchema = z.object({
  key: actionCacheValueSchema,
  version: actionCacheValueSchema,
});

function hasValue(value: string): boolean {
  return value.trim().length > 0;
}

function byteBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
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
    ["sign"],
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

function validCacheKey(value: string | null): value is string {
  return value !== null && cacheKeyPattern.test(value);
}

function validRunnerCacheScope(value: string): boolean {
  return runnerCacheScopeSchema.safeParse(value).success;
}

function normalizedRepository(repository: string): string {
  return encodeURIComponent(repository.trim().toLowerCase());
}

export function runnerCacheEnabled(env: Pick<RunnerCacheEnvironment, "RUNNER_CACHE_ENABLED">): boolean {
  // Existing pools predate this setting; preserve their cache behaviour until
  // setup explicitly chooses to turn it off.
  return env.RUNNER_CACHE_ENABLED !== "false";
}

export function runnerCachePrefix(env: Pick<RunnerCacheEnvironment, "RUNNER_CACHE_PREFIX">): string {
  const configured = env.RUNNER_CACHE_PREFIX?.trim();
  return configured !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(configured)
    ? configured
    : defaultRunnerCachePrefix;
}

export function runnerCacheMaxBytes(env: Pick<RunnerCacheEnvironment, "RUNNER_CACHE_MAX_BYTES">): number {
  const configured = Number(env.RUNNER_CACHE_MAX_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : defaultRunnerCacheMaxBytes;
}

export function runnerCacheLegacyPrefix(env: Pick<RunnerCacheEnvironment, "RUNNER_CACHE_PREFIX">): string {
  return `${runnerCachePrefix(env)}/npm/`;
}

export function runnerCacheArchivePrefix(env: Pick<RunnerCacheEnvironment, "RUNNER_CACHE_PREFIX">): string {
  return `${runnerCachePrefix(env)}/actions-cache-v2/archives/`;
}

export function runnerCacheManifestPrefix(env: Pick<RunnerCacheEnvironment, "RUNNER_CACHE_PREFIX">): string {
  return `${runnerCachePrefix(env)}/actions-cache-v2/`;
}

export function runnerCacheObjectKey(repository: string, key: string, cachePrefix = defaultRunnerCachePrefix): string {
  if (!validCacheKey(key)) {
    throw new Error("Runner cache key is invalid");
  }
  return `${cachePrefix}/npm/${normalizedRepository(repository)}/${key}.tar.zst`;
}

function runnerCacheObjectPrefix(repository: string, prefix: string, cachePrefix: string): string {
  if (!validCacheKey(prefix)) {
    throw new Error("Runner cache restore prefix is invalid");
  }
  return `${cachePrefix}/npm/${normalizedRepository(repository)}/${prefix}`;
}

export async function createRunnerCacheAuthorization(
  secret: string,
  input: Omit<RunnerCacheClaim, "version" | "expiresAt">,
  now = Date.now(),
): Promise<string> {
  if (!hasValue(secret)) {
    throw new Error("RUNNER_CACHE_SIGNING_KEY is not configured");
  }
  const claim: RunnerCacheClaim = { ...input, version: 1, expiresAt: now + runnerCacheTokenLifetimeMs };
  const payload = new TextEncoder().encode(JSON.stringify(claim));
  return `${encodeBase64Url(payload)}.${encodeBase64Url(await hmac(secret, payload))}`;
}

export async function verifyRunnerCacheAuthorization(
  secret: string,
  authorization: string | null,
  now = Date.now(),
): Promise<RunnerCacheClaim | undefined> {
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
    const claim = runnerCacheClaimSchema.safeParse(JSON.parse(new TextDecoder().decode(payload)));
    return claim.success && claim.data.expiresAt > now ? claim.data : undefined;
  } catch {
    return undefined;
  }
}

async function createActionCacheSession(
  secret: string,
  input: Omit<ActionCacheSession, "version" | "expiresAt">,
  now = Date.now(),
): Promise<string> {
  const session: ActionCacheSession = { ...input, version: 1, expiresAt: now + actionCacheTokenLifetimeMs };
  const payload = new TextEncoder().encode(JSON.stringify(session));
  return `${encodeBase64Url(payload)}.${encodeBase64Url(await hmac(secret, payload))}`;
}

async function verifyActionCacheSession(
  secret: string,
  token: string | null,
  now = Date.now(),
): Promise<ActionCacheSession | undefined> {
  if (!hasValue(secret) || token === null) {
    return undefined;
  }
  const [encodedClaim, encodedSignature, extraPart] = token.split(".");
  if (encodedClaim === undefined || encodedSignature === undefined || extraPart !== undefined) {
    return undefined;
  }
  const payload = decodeBase64Url(encodedClaim);
  const signature = decodeBase64Url(encodedSignature);
  if (payload === undefined || signature === undefined || !(await hasValidSignature(secret, payload, signature))) {
    return undefined;
  }
  try {
    const session = actionCacheSessionSchema.safeParse(JSON.parse(new TextDecoder().decode(payload)));
    return session.success && session.data.expiresAt > now ? session.data : undefined;
  } catch {
    return undefined;
  }
}

async function cacheDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return encodeBase64Url(new Uint8Array(digest));
}

async function actionCacheManifestPrefix(
  env: Pick<RunnerCacheEnvironment, "RUNNER_CACHE_PREFIX">,
  repository: string,
  cacheVersion: string,
  scope: string,
): Promise<string> {
  return `${runnerCacheManifestPrefix(env)}${await cacheDigest(repository.toLowerCase())}/${await cacheDigest(scope)}/manifests/${await cacheDigest(cacheVersion)}/`;
}

async function actionCacheManifestKey(
  env: Pick<RunnerCacheEnvironment, "RUNNER_CACHE_PREFIX">,
  repository: string,
  cacheKey: string,
  cacheVersion: string,
  scope: string,
): Promise<string> {
  return `${await actionCacheManifestPrefix(env, repository, cacheVersion, scope)}${await cacheDigest(cacheKey)}.json`;
}

async function readActionCacheManifest(bucket: R2Bucket, key: string): Promise<ActionCacheManifest | undefined> {
  const object = await bucket.get(key);
  if (object === null) {
    return undefined;
  }
  try {
    const manifest = actionCacheManifestSchema.safeParse(await object.json<z.core.util.JSONType>());
    return manifest.success ? manifest.data : undefined;
  } catch {
    return undefined;
  }
}

async function authenticatedRunnerCacheClaim(
  request: Request,
  env: RunnerCacheEnvironment,
): Promise<RunnerCacheClaim | undefined> {
  return verifyRunnerCacheAuthorization(env.RUNNER_CACHE_SIGNING_KEY, request.headers.get("Authorization"));
}

function sameActionCacheSession(session: ActionCacheSession, claim: RunnerCacheClaim): boolean {
  return (
    session.runnerName === claim.runnerName &&
    session.jobId === claim.jobId &&
    session.repository.toLowerCase() === claim.repository.toLowerCase() &&
    session.scope === claim.scope &&
    session.fallbackScope === claim.fallbackScope
  );
}

interface ResolvedRunnerCacheClaim {
  claim: RunnerCacheClaim;
  writeAllowed: boolean;
}

/**
 * Convert the short-lived, runner-scoped capability into the cache scope of
 * the job GitHub actually assigned. A JIT runner can be given a different
 * compatible queued job than the one that requested it; binding cache access
 * to its runner assignment preserves GitHub's cache isolation in that case.
 */
async function resolveRunnerCacheClaim(
  writeAuthorizer: RunnerCacheWriteAuthorizer,
  claim: RunnerCacheClaim,
): Promise<ResolvedRunnerCacheClaim | undefined> {
  const assignment =
    writeAuthorizer.cacheAssignment === undefined
      ? undefined
      : await writeAuthorizer.cacheAssignment(claim.runnerName, claim.repository);
  if (
    assignment !== undefined &&
    validRunnerCacheScope(assignment.cacheScope.scope) &&
    (assignment.cacheScope.fallbackScope === undefined || validRunnerCacheScope(assignment.cacheScope.fallbackScope))
  ) {
    const assignedClaim: RunnerCacheClaim = {
      ...claim,
      jobId: assignment.jobId,
      scope: assignment.cacheScope.scope,
      fallbackScope: assignment.cacheScope.fallbackScope,
    };
    return {
      claim: assignedClaim,
      writeAllowed: assignment.cacheScope.writeAllowed,
    };
  }

  const scope =
    writeAuthorizer.cacheScope === undefined
      ? (await writeAuthorizer.canWriteCache?.(claim.runnerName, claim.repository)) === true
        ? {
            scope: claim.scope,
            fallbackScope: claim.fallbackScope,
            writeAllowed: true,
          }
        : undefined
      : await writeAuthorizer.cacheScope(claim.runnerName, claim.repository, claim.jobId);
  if (scope !== undefined && scope.scope === claim.scope && scope.fallbackScope === claim.fallbackScope) {
    return { claim, writeAllowed: scope.writeAllowed };
  }
  console.log("Cloudflare runner cache write denied", {
    runnerName: claim.runnerName,
    jobId: claim.jobId,
    repository: claim.repository,
    claimScope: claim.scope,
    claimFallbackScope: claim.fallbackScope,
    assignedJobId: assignment?.jobId,
    assignedScope: assignment?.cacheScope.scope ?? scope?.scope,
    assignedFallbackScope: assignment?.cacheScope.fallbackScope ?? scope?.fallbackScope,
    assignedWriteAllowed: assignment?.cacheScope.writeAllowed ?? scope?.writeAllowed,
  });
  return undefined;
}

export async function createRunnerCacheContainerConfiguration(
  env: Pick<RunnerCacheEnvironment, "RUNNER_CACHE_SIGNING_KEY" | "RUNNER_CACHE_ENABLED">,
  assignment: RunnerCacheAssignment,
): Promise<RunnerCacheContainerConfiguration | undefined> {
  if (
    !runnerCacheEnabled(env) ||
    !validRunnerCacheScope(assignment.cacheScope.scope) ||
    (assignment.cacheScope.fallbackScope !== undefined && !validRunnerCacheScope(assignment.cacheScope.fallbackScope))
  ) {
    return undefined;
  }
  const repository = `${assignment.target.owner}/${assignment.target.repository}`;
  const authorization = await createRunnerCacheAuthorization(env.RUNNER_CACHE_SIGNING_KEY, {
    runnerName: assignment.runnerName,
    jobId: assignment.jobId,
    repository,
    scope: assignment.cacheScope.scope,
    fallbackScope: assignment.cacheScope.fallbackScope,
  });
  return {
    endpoint: new URL("/v1/runner-cache", assignment.workerOrigin).toString(),
    authorization: `Bearer ${authorization}`,
  };
}

function json(body: z.core.util.JSONType, status = 200): Response {
  return Response.json(body, { status });
}

function runnerCacheQuota(env: RunnerCacheEnvironment): RunnerCacheQuotaStub | undefined {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  return accountId === undefined || accountId === "" ? undefined : env.RUNNER_CACHE_QUOTA?.getByName(accountId);
}

async function cacheObjectForRestore(
  bucket: R2Bucket,
  claim: RunnerCacheClaim,
  key: string,
  restorePrefix: string | null,
  cachePrefix: string,
): Promise<R2ObjectBody | null> {
  const exact = await bucket.get(runnerCacheObjectKey(claim.repository, key, cachePrefix));
  if (exact !== null) {
    return exact;
  }
  if (restorePrefix === null) {
    return null;
  }
  if (!validCacheKey(restorePrefix)) {
    throw new Error("Runner cache restore prefix is invalid");
  }
  const listed = await bucket.list({
    prefix: runnerCacheObjectPrefix(claim.repository, restorePrefix, cachePrefix),
    limit: 1_000,
  });
  const newest = listed.objects.reduce<R2Object | undefined>(
    (candidate, object) => (candidate === undefined || object.uploaded > candidate.uploaded ? object : candidate),
    undefined,
  );
  return newest === undefined ? null : await bucket.get(newest.key);
}

export async function handleRunnerCacheRequest(
  request: Request,
  env: RunnerCacheEnvironment,
  writeAuthorizer: RunnerCacheWriteAuthorizer,
): Promise<Response> {
  const claim = await verifyRunnerCacheAuthorization(
    env.RUNNER_CACHE_SIGNING_KEY,
    request.headers.get("Authorization"),
  );
  if (claim === undefined) {
    return json({ error: "Unauthorized" }, 401);
  }
  const resolved = await resolveRunnerCacheClaim(writeAuthorizer, claim);
  // The legacy endpoint remains read-compatible for callers which have not
  // upgraded to scheduler-backed assignments. CacheService v2 always requires
  // a resolved assignment below.
  const assignedClaim = resolved?.claim ?? claim;
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!validCacheKey(key)) {
    return json({ error: "Invalid cache key" }, 400);
  }

  if (request.method === "GET") {
    let cached: R2ObjectBody | null;
    try {
      cached = await cacheObjectForRestore(
        env.RUNNER_CACHE,
        assignedClaim,
        key,
        url.searchParams.get("restore_prefix"),
        runnerCachePrefix(env),
      );
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Invalid cache restore request" }, 400);
    }
    if (cached === null) {
      return json({ error: "Cache miss" }, 404);
    }
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Content-Type": "application/zstd",
      "X-Cloudflare-Runner-Cache-Key": cached.key,
    });
    cached.writeHttpMetadata(headers);
    headers.set("Cache-Control", "no-store");
    return new Response(cached.body, { headers });
  }

  if (request.method !== "PUT") {
    return json({ error: "Method not allowed" }, 405);
  }
  if (request.body === null) {
    return json({ error: "Cache upload body is required" }, 400);
  }
  if (resolved?.writeAllowed !== true) {
    return json({ error: "Cache writes are not allowed for this assigned GitHub cache scope" }, 403);
  }
  const objectKey = runnerCacheObjectKey(assignedClaim.repository, key, runnerCachePrefix(env));
  const stored = await env.RUNNER_CACHE.put(objectKey, request.body, {
    httpMetadata: { contentType: "application/zstd" },
    customMetadata: { repository: assignedClaim.repository, runner: assignedClaim.runnerName },
  });
  const quota = runnerCacheQuota(env);
  if (quota !== undefined) {
    const result = await quota.recordLegacyCache({ objectKey, sizeBytes: stored.size, createdAt: Date.now() });
    if (!result.retained) {
      return json({ error: `Cache archive exceeds the configured ${runnerCacheMaxBytes(env)} byte R2 limit` }, 413);
    }
  }
  return json({ stored: true }, 201);
}

async function actionCacheManifestForScope(
  env: RunnerCacheEnvironment,
  repository: string,
  lookup: { key: string; version: string; restoreKeys: string[] },
  scope: string,
): Promise<ActionCacheManifest | undefined> {
  let manifest = await readActionCacheManifest(
    env.RUNNER_CACHE,
    await actionCacheManifestKey(env, repository, lookup.key, lookup.version, scope),
  );
  if (manifest !== undefined) {
    return manifest;
  }

  const prefix = await actionCacheManifestPrefix(env, repository, lookup.version, scope);
  const manifests: ActionCacheManifest[] = [];
  let cursor: string | undefined;
  do {
    // eslint-disable-next-line no-await-in-loop -- R2 cursors must be consumed sequentially.
    const listed = await env.RUNNER_CACHE.list({ prefix, cursor, limit: 1_000 });
    for (const listedObject of listed.objects) {
      // eslint-disable-next-line no-await-in-loop -- each manifest validates the list entry before use.
      const candidate = await readActionCacheManifest(env.RUNNER_CACHE, listedObject.key);
      if (candidate !== undefined) {
        manifests.push(candidate);
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);

  for (const restoreKey of lookup.restoreKeys) {
    const candidates = manifests.filter((candidate) => candidate.cacheKey.startsWith(restoreKey));
    candidates.sort((left, right) => right.createdAt - left.createdAt);
    manifest = candidates[0];
    if (manifest !== undefined) {
      return manifest;
    }
  }
  return undefined;
}

async function actionCacheLookup(
  request: Request,
  env: RunnerCacheEnvironment,
  claim: RunnerCacheClaim,
): Promise<Response> {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ msg: "Invalid cache lookup payload" }, 400);
  }
  const parsedLookup = actionCacheRequestSchema.safeParse(payload);
  if (!parsedLookup.success) {
    return json({ msg: "Invalid cache lookup payload" }, 400);
  }
  const lookup = parsedLookup.data;

  let manifest = await actionCacheManifestForScope(env, claim.repository, lookup, claim.scope);
  if (manifest === undefined && claim.fallbackScope !== undefined && claim.fallbackScope !== claim.scope) {
    manifest = await actionCacheManifestForScope(env, claim.repository, lookup, claim.fallbackScope);
  }

  if (manifest === undefined || (await env.RUNNER_CACHE.head(manifest.objectKey)) === null) {
    return json({ ok: false, signedDownloadUrl: "", matchedKey: "" });
  }
  const token = await createActionCacheSession(env.RUNNER_CACHE_SIGNING_KEY, {
    kind: "download",
    runnerName: claim.runnerName,
    jobId: claim.jobId,
    repository: claim.repository,
    scope: claim.scope,
    fallbackScope: claim.fallbackScope,
    cacheKey: manifest.cacheKey,
    cacheVersion: manifest.cacheVersion,
    objectKey: manifest.objectKey,
  });
  const downloadUrl = new URL("/v1/runner-cache-v2/download", request.url);
  downloadUrl.searchParams.set("token", token);
  return json({ ok: true, signedDownloadUrl: downloadUrl.toString(), matchedKey: manifest.cacheKey });
}

async function actionCacheCreate(
  request: Request,
  env: RunnerCacheEnvironment,
  claim: RunnerCacheClaim,
  writeAllowed: boolean,
): Promise<Response> {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, message: "Invalid cache reservation payload" }, 400);
  }
  const parsedCacheRequest = actionCacheRequestSchema.safeParse(payload);
  if (!parsedCacheRequest.success) {
    return json({ ok: false, message: "Invalid cache reservation payload" }, 400);
  }
  const cacheRequest = parsedCacheRequest.data;
  if (!writeAllowed) {
    return json({ ok: false, message: "cache write denied: runner is not assigned to this GitHub cache scope" });
  }

  const entryId = crypto.randomUUID();
  const objectKey = `${runnerCacheArchivePrefix(env)}${await cacheDigest(claim.repository.toLowerCase())}/${await cacheDigest(claim.scope)}/${entryId}.tar.zst`;
  const upload = await env.RUNNER_CACHE.createMultipartUpload(objectKey, {
    httpMetadata: { contentType: "application/zstd" },
    customMetadata: { repository: claim.repository, runner: claim.runnerName },
  });
  const session = await createActionCacheSession(env.RUNNER_CACHE_SIGNING_KEY, {
    kind: "upload",
    runnerName: claim.runnerName,
    jobId: claim.jobId,
    repository: claim.repository,
    scope: claim.scope,
    fallbackScope: claim.fallbackScope,
    cacheKey: cacheRequest.key,
    cacheVersion: cacheRequest.version,
    objectKey,
    uploadId: upload.uploadId,
  });
  return json({ ok: true, session });
}

function actionCachePartNumber(blockId: string): number | undefined {
  try {
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(blockId), (character) => character.charCodeAt(0)));
    const blockIndex = decoded.match(/(\d{1,6})$/u)?.[1];
    if (blockIndex === undefined) {
      return undefined;
    }
    const partNumber = Number(blockIndex) + 1;
    return Number.isSafeInteger(partNumber) && partNumber > 0 && partNumber <= 10_000 ? partNumber : undefined;
  } catch {
    return undefined;
  }
}

async function verifiedUploadSession(
  request: Request,
  env: RunnerCacheEnvironment,
  claim: RunnerCacheClaim,
): Promise<UploadActionCacheSession | undefined> {
  const token = new URL(request.url).searchParams.get("session");
  const session = await verifyActionCacheSession(env.RUNNER_CACHE_SIGNING_KEY, token);
  if (session?.kind !== "upload" || session.uploadId === undefined || !sameActionCacheSession(session, claim)) {
    return undefined;
  }
  return { ...session, kind: "upload", uploadId: session.uploadId };
}

async function actionCacheUpload(
  request: Request,
  env: RunnerCacheEnvironment,
  claim: RunnerCacheClaim,
  writeAllowed: boolean,
): Promise<Response> {
  const session = await verifiedUploadSession(request, env, claim);
  if (session === undefined) {
    return json({ error: "Unauthorized cache upload session" }, 401);
  }
  if (!writeAllowed) {
    return json({ error: "Cache write denied" }, 403);
  }
  if (request.body === null) {
    return json({ error: "Cache upload body is required" }, 400);
  }
  const blockId = new URL(request.url).searchParams.get("block_id");
  if (blockId === null) {
    await env.RUNNER_CACHE.resumeMultipartUpload(session.objectKey, session.uploadId).abort();
    await env.RUNNER_CACHE.put(session.objectKey, request.body, {
      httpMetadata: { contentType: "application/zstd" },
      customMetadata: { repository: claim.repository, runner: claim.runnerName },
    });
    return json({ ok: true, direct: true });
  }
  const partNumber = actionCachePartNumber(blockId);
  if (partNumber === undefined) {
    return json({ error: "Invalid Azure block ID" }, 400);
  }
  const part = await env.RUNNER_CACHE.resumeMultipartUpload(session.objectKey, session.uploadId).uploadPart(
    partNumber,
    request.body,
  );
  return json({ ok: true, partNumber: part.partNumber, etag: part.etag });
}

async function actionCacheComplete(
  request: Request,
  env: RunnerCacheEnvironment,
  claim: RunnerCacheClaim,
  writeAllowed: boolean,
): Promise<Response> {
  const session = await verifiedUploadSession(request, env, claim);
  if (session === undefined) {
    return json({ error: "Unauthorized cache upload session" }, 401);
  }
  if (!writeAllowed) {
    return json({ error: "Cache write denied" }, 403);
  }
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid cache upload completion payload" }, 400);
  }
  const completedParts = completedPartsPayloadSchema.safeParse(payload);
  if (!completedParts.success) {
    return json({ error: "Invalid cache upload completion payload" }, 400);
  }
  const { parts } = completedParts.data;
  const uploadedParts: R2UploadedPart[] = [];
  const partNumbers = new Set<number>();
  for (const part of parts) {
    if (actionCachePartNumber(part.blockId) !== part.partNumber || partNumbers.has(part.partNumber)) {
      return json({ error: "Invalid Azure block list" }, 400);
    }
    partNumbers.add(part.partNumber);
    uploadedParts.push({ partNumber: part.partNumber, etag: part.etag });
  }
  try {
    await env.RUNNER_CACHE.resumeMultipartUpload(session.objectKey, session.uploadId).complete(uploadedParts);
    // `commitActionCache()` handles quota accounting only after GitHub has
    // finalized the entry. This keeps a temporary multipart archive out of
    // the quota controller's public index and makes completion a single R2
    // operation.
  } catch (error) {
    // R2 multipart uploads can disappear or be completed in another request.
    // Treat those as an ordinary cache-save failure rather than allowing the
    // exception to become Cloudflare's HTML error page, which actions/cache
    // cannot surface usefully in its job log.
    console.error("Could not complete Cloudflare R2 cache multipart upload", {
      runnerName: claim.runnerName,
      jobId: claim.jobId,
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ error: "Could not complete the Cloudflare R2 cache archive" }, 502);
  }
  return json({ ok: true });
}

async function actionCacheFinalize(
  request: Request,
  env: RunnerCacheEnvironment,
  claim: RunnerCacheClaim,
  writeAllowed: boolean,
): Promise<Response> {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, message: "Invalid cache finalize payload" }, 400);
  }
  const finalized = actionCacheFinalizeSchema.safeParse(payload);
  if (!finalized.success) {
    return json({ ok: false, message: "Invalid cache finalize payload" }, 400);
  }
  const values = finalized.data;
  const session = await verifyActionCacheSession(
    env.RUNNER_CACHE_SIGNING_KEY,
    new URL(request.url).searchParams.get("session"),
  );
  if (
    session?.kind !== "upload" ||
    !sameActionCacheSession(session, claim) ||
    session.cacheKey !== values.key ||
    session.cacheVersion !== values.version
  ) {
    return json({ ok: false, message: "Invalid cache finalize session" }, 401);
  }
  if (!writeAllowed) {
    return json({ ok: false, message: "cache write denied: runner is not assigned to this GitHub cache scope" });
  }
  const archive = await env.RUNNER_CACHE.head(session.objectKey);
  if (archive === null) {
    return json({ ok: false, message: "Cache archive upload was not completed" });
  }

  const manifest: ActionCacheManifest = {
    entryId: crypto.randomUUID(),
    cacheKey: session.cacheKey,
    cacheVersion: session.cacheVersion,
    objectKey: session.objectKey,
    createdAt: Date.now(),
  };
  const quota = runnerCacheQuota(env);
  if (quota === undefined) {
    return json({ ok: false, message: "R2 cache quota controller is unavailable" }, 503);
  }
  let result: CacheQuotaActionCommitResult;
  try {
    result = await quota.commitActionCache({
      manifestKey: await actionCacheManifestKey(
        env,
        claim.repository,
        session.cacheKey,
        session.cacheVersion,
        claim.scope,
      ),
      manifest,
      sizeBytes: archive.size,
      customMetadata: { repository: claim.repository, cacheVersion: await cacheDigest(session.cacheVersion) },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Could not finalize Cloudflare R2 cache quota entry", {
      runnerName: claim.runnerName,
      jobId: claim.jobId,
      error: message,
    });
    return json({ ok: false, message: `Could not finalize the Cloudflare R2 cache entry: ${message}` }, 503);
  }
  if (result.kind === "already-exists") {
    return json({ ok: false, message: "Cache already exists" });
  }
  if (result.kind === "too-large") {
    return json({ ok: false, message: `Cache archive exceeds the configured ${result.maximumBytes} byte R2 limit` });
  }
  // CacheService declares entryId as an int64. The archive's UUID stays only
  // in the manifest; action/cache only needs any successful, numeric entry ID.
  return json({ ok: true, entryId: "1" });
}

async function actionCacheDownload(request: Request, env: RunnerCacheEnvironment): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  const session = await verifyActionCacheSession(env.RUNNER_CACHE_SIGNING_KEY, token);
  if (session?.kind !== "download") {
    return json({ error: "Unauthorized" }, 401);
  }
  const object = await env.RUNNER_CACHE.get(session.objectKey);
  if (object === null) {
    return json({ error: "Cache miss" }, 404);
  }
  const headers = new Headers({ "Cache-Control": "no-store", "Content-Type": "application/zstd" });
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "no-store");
  return new Response(object.body, { headers });
}

/**
 * GitHub's CacheService v2 control plane for the local runner proxy. Uploads
 * use Azure-Blob-shaped requests locally, then stream through this Worker into
 * R2 multipart uploads; artifact ResultService RPCs never reach this handler.
 */
export async function handleRunnerCacheV2Request(
  request: Request,
  env: RunnerCacheEnvironment,
  writeAuthorizer: RunnerCacheWriteAuthorizer,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/v1/runner-cache-v2/download") {
    return actionCacheDownload(request, env);
  }
  const claim = await authenticatedRunnerCacheClaim(request, env);
  if (claim === undefined) {
    return json({ error: "Unauthorized" }, 401);
  }
  const resolved = await resolveRunnerCacheClaim(writeAuthorizer, claim);
  // GitHub can start a JIT runner a moment before its authoritative
  // `workflow_job: in_progress` webhook reaches this Worker. The runner's
  // pre-job hook polls this endpoint, so actions/cache never observes that
  // short-lived unassigned state as an insecure 403 response.
  if (request.method === "GET" && url.pathname === "/v1/runner-cache-v2/assignment") {
    return json({ ok: resolved !== undefined }, resolved === undefined ? 202 : 200);
  }
  if (resolved === undefined) {
    return json({ ok: false, message: "cache runner is not assigned to a GitHub job" }, 403);
  }
  const assignedClaim = resolved.claim;
  if (request.method === "POST" && url.pathname === "/v1/runner-cache-v2/lookup") {
    return actionCacheLookup(request, env, assignedClaim);
  }
  if (request.method === "POST" && url.pathname === "/v1/runner-cache-v2/create") {
    return actionCacheCreate(request, env, assignedClaim, resolved.writeAllowed);
  }
  if (request.method === "PUT" && url.pathname === "/v1/runner-cache-v2/upload") {
    return actionCacheUpload(request, env, assignedClaim, resolved.writeAllowed);
  }
  if (request.method === "POST" && url.pathname === "/v1/runner-cache-v2/complete") {
    return actionCacheComplete(request, env, assignedClaim, resolved.writeAllowed);
  }
  if (request.method === "POST" && url.pathname === "/v1/runner-cache-v2/finalize") {
    return actionCacheFinalize(request, env, assignedClaim, resolved.writeAllowed);
  }
  return json({ error: "Not found" }, 404);
}
