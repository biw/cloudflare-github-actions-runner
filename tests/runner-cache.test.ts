import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  createRunnerCacheAuthorization,
  createRunnerCacheContainerConfiguration,
  handleRunnerCacheRequest,
  handleRunnerCacheV2Request,
  runnerCacheObjectKey,
  verifyRunnerCacheAuthorization,
  type CacheQuotaActionCommit,
  type CacheQuotaActionCommitResult,
  type CacheQuotaLegacyRecord,
  type CacheQuotaLegacyRecordResult,
} from "../src/runner-cache";

const claimInput = {
  runnerName: "cf-standard-3-job-42",
  jobId: "42",
  repository: "biw/example",
  scope: "refs/heads/main",
};

interface TestCacheAssignment {
  jobId: string;
  cacheScope: { scope: string; writeAllowed: boolean };
}

type TestCacheAssignmentResult = TestCacheAssignment | undefined;

const sessionResponseSchema = z.object({ session: z.string() });
const cacheHitResponseSchema = z.object({ ok: z.boolean(), signedDownloadUrl: z.string() });
const matchedCacheHitResponseSchema = cacheHitResponseSchema.extend({ matchedKey: z.string() });

async function parseResponseJson<Schema extends z.ZodType>(
  response: Response,
  schema: Schema,
): Promise<z.infer<Schema>> {
  return schema.parse(await response.json());
}

function r2Object<const Value extends object>(value: Value): R2Object {
  // SAFETY: these R2 fixtures supply every object field read by the cache operation under test.
  return value as R2Object;
}

function r2ObjectBody<const Value extends object>(value: Value): R2ObjectBody {
  // SAFETY: these body fixtures supply every R2ObjectBody field and method read by the cache operation under test.
  return value as R2ObjectBody;
}

function r2MultipartUpload<const Value extends object>(value: Value): R2MultipartUpload {
  // SAFETY: these multipart fixtures supply every upload method exercised by the cache operation under test.
  return value as R2MultipartUpload;
}

function object(key: string, content: string, uploaded = new Date("2026-08-13T00:00:00Z")): R2ObjectBody {
  const body = new Response(content).body;
  if (body === null) {
    throw new Error("Could not create the R2 test body");
  }
  return r2ObjectBody({
    key,
    uploaded,
    body,
    writeHttpMetadata: vi.fn<(headers: Headers) => void>(),
  });
}

function cacheEnvironment<const Bucket extends object>(bucket: Bucket) {
  return {
    RUNNER_CACHE_SIGNING_KEY: "cache-signing-key",
    // SAFETY: each bucket double implements the R2 methods exercised by its test case.
    RUNNER_CACHE: bucket as R2Bucket,
    RUNNER_CACHE_ENABLED: "true",
    RUNNER_CACHE_MAX_BYTES: "100000000000",
    RUNNER_CACHE_PREFIX: "cloudflare-github-actions-runner",
    CLOUDFLARE_ACCOUNT_ID: "account-id",
    RUNNER_CACHE_QUOTA: {
      getByName: () => ({
        recordLegacyCache: vi
          .fn<(input: CacheQuotaLegacyRecord) => Promise<CacheQuotaLegacyRecordResult>>()
          .mockResolvedValue({ retained: true }),
        commitActionCache: vi
          .fn<(input: CacheQuotaActionCommit) => Promise<CacheQuotaActionCommitResult>>()
          .mockResolvedValue({ kind: "stored" }),
      }),
    },
  };
}

function actionCacheEnvironment(bucket: ReturnType<typeof actionCacheBucket>) {
  const environment = cacheEnvironment(bucket);
  environment.RUNNER_CACHE_QUOTA = {
    getByName: () => ({
      recordLegacyCache: vi
        .fn<(input: CacheQuotaLegacyRecord) => Promise<CacheQuotaLegacyRecordResult>>()
        .mockResolvedValue({ retained: true }),
      commitActionCache: vi
        .fn<(input: CacheQuotaActionCommit) => Promise<CacheQuotaActionCommitResult>>()
        .mockImplementation(async ({ manifestKey, manifest, customMetadata }) => {
          const stored = await bucket.put(manifestKey, JSON.stringify(manifest), {
            onlyIf: { etagDoesNotMatch: "*" },
            httpMetadata: { contentType: "application/json" },
            customMetadata,
          });
          if (stored === null) {
            const existing = await bucket
              .get(manifestKey)
              .then((existingObject) => existingObject?.json<{ objectKey?: unknown }>());
            if (existing?.objectKey === manifest.objectKey) {
              return { kind: "stored" };
            }
            await bucket.delete(manifest.objectKey);
            return { kind: "already-exists" };
          }
          return { kind: "stored" };
        }),
    }),
  };
  return environment;
}

function actionCacheBucket() {
  const values = new Map<string, Uint8Array>();
  const uploaded = new Map<string, Date>();
  const multipartParts = new Map<string, Map<number, Uint8Array>>();
  const cacheObject = (key: string, value: Uint8Array): R2ObjectBody => {
    const body = new Uint8Array(value).buffer;
    const response = new Response(body);
    if (response.body === null) {
      throw new Error("Could not create the action-cache R2 test body");
    }
    return r2ObjectBody({
      key,
      uploaded: uploaded.get(key) ?? new Date(),
      body: response.body,
      json: () => new Response(body).json(),
      writeHttpMetadata: vi.fn<(headers: Headers) => void>(),
    });
  };
  return {
    createMultipartUpload: vi
      .fn<(key: string, options?: R2MultipartOptions) => Promise<R2MultipartUpload>>()
      .mockResolvedValue(r2MultipartUpload({ key: "pending", uploadId: "upload-1" })),
    resumeMultipartUpload: vi
      .fn<(key: string, uploadId: string) => R2MultipartUpload>()
      .mockImplementation((key, uploadId) => ({
        key,
        uploadId,
        abort: vi.fn<() => Promise<void>>().mockImplementation(async () => {
          multipartParts.delete(key);
        }),
        uploadPart: vi
          .fn<(partNumber: number, value: ReadableStream) => Promise<R2UploadedPart>>()
          .mockImplementation(async (partNumber, value) => {
            const parts = multipartParts.get(key) ?? new Map<number, Uint8Array>();
            multipartParts.set(key, parts);
            parts.set(partNumber, new Uint8Array(await new Response(value).arrayBuffer()));
            return { partNumber, etag: `etag-${partNumber}` };
          }),
        complete: vi.fn<(parts: R2UploadedPart[]) => Promise<R2Object>>().mockImplementation(async (parts) => {
          const valuesByPart = multipartParts.get(key) ?? new Map<number, Uint8Array>();
          const size = parts.reduce((total, part) => total + (valuesByPart.get(part.partNumber)?.byteLength ?? 0), 0);
          const combined = new Uint8Array(size);
          let offset = 0;
          for (const part of parts) {
            const value = valuesByPart.get(part.partNumber);
            if (value !== undefined) {
              combined.set(value, offset);
              offset += value.byteLength;
            }
          }
          values.set(key, combined);
          uploaded.set(key, new Date());
          multipartParts.delete(key);
          return r2Object({ key, size });
        }),
      })),
    put: vi.fn<(key: string, value: BodyInit | null, options?: R2PutOptions) => Promise<R2Object | null>>(
      async (key, value, options) => {
        const condition = options?.onlyIf;
        if (
          condition !== undefined &&
          !(condition instanceof Headers) &&
          "etagDoesNotMatch" in condition &&
          condition.etagDoesNotMatch === "*" &&
          values.has(key)
        ) {
          return null;
        }
        const storedValue = new Uint8Array(await new Response(value).arrayBuffer());
        values.set(key, storedValue);
        uploaded.set(key, new Date());
        return r2Object({ key, size: storedValue.byteLength });
      },
    ),
    get: vi.fn<(key: string) => Promise<R2ObjectBody | null>>(async (key) => {
      const value = values.get(key);
      return value === undefined ? null : cacheObject(key, value);
    }),
    delete: vi.fn<(keys: string | string[]) => Promise<void>>().mockImplementation(async (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        values.delete(key);
        uploaded.delete(key);
      }
    }),
    head: vi.fn<(key: string) => Promise<R2Object | null>>(async (key) => {
      const value = values.get(key);
      return value === undefined ? null : r2Object({ key, size: value.byteLength });
    }),
    list: vi.fn<(options?: R2ListOptions) => Promise<R2Objects>>(async ({ prefix } = {}) => ({
      objects: [...values.entries()]
        .filter(([key]) => prefix === undefined || key.startsWith(prefix))
        .map(([key]) => r2Object({ key, uploaded: uploaded.get(key) ?? new Date() })),
      truncated: false,
      delimitedPrefixes: [],
    })),
  };
}

async function authorization(input = claimInput, now = Date.now()): Promise<string> {
  return `Bearer ${await createRunnerCacheAuthorization("cache-signing-key", input, now)}`;
}

describe("runner R2 cache", () => {
  it("creates and verifies an expiring runner-scoped capability", async () => {
    const token = await createRunnerCacheAuthorization("cache-signing-key", claimInput, 1_000);

    await expect(verifyRunnerCacheAuthorization("cache-signing-key", `Bearer ${token}`, 1_001)).resolves.toEqual({
      version: 1,
      ...claimInput,
      expiresAt: 1_801_000,
    });
    await expect(verifyRunnerCacheAuthorization("other-key", `Bearer ${token}`, 1_001)).resolves.toBeUndefined();
    await expect(
      verifyRunnerCacheAuthorization("cache-signing-key", `Bearer ${token}`, 1_801_000),
    ).resolves.toBeUndefined();
  });

  it("streams an exact repository cache hit through the Worker binding", async () => {
    const key = "pnpm-linux-x64-node-22-lock";
    const stored = object(runnerCacheObjectKey(claimInput.repository, key), "compressed-cache");
    const bucket = {
      get: vi.fn<(...args: unknown[]) => Promise<R2ObjectBody | null>>().mockResolvedValue(stored),
      list: vi.fn<(...args: unknown[]) => Promise<R2Objects>>(),
    };

    const response = await handleRunnerCacheRequest(
      new Request(`https://runner.example/v1/runner-cache?key=${key}`, {
        headers: { Authorization: await authorization() },
      }),
      cacheEnvironment(bucket),
      { canWriteCache: vi.fn<(runnerName: string, repository: string) => Promise<boolean>>() },
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("compressed-cache");
    expect(bucket.get).toHaveBeenCalledWith(runnerCacheObjectKey(claimInput.repository, key));
    expect(bucket.list).not.toHaveBeenCalled();
  });

  it("uses the newest matching restore prefix only after an exact miss", async () => {
    const key = "pnpm-linux-x64-node-22-new-lock";
    const older = {
      key: runnerCacheObjectKey(claimInput.repository, "pnpm-linux-x64-node-22-old"),
      uploaded: new Date(1_000),
    };
    const newer = {
      key: runnerCacheObjectKey(claimInput.repository, "pnpm-linux-x64-node-22-newer"),
      uploaded: new Date(2_000),
    };
    const stored = object(newer.key, "fallback-cache", newer.uploaded);
    const bucket = {
      get: vi
        .fn<(...args: unknown[]) => Promise<R2ObjectBody | null>>()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(stored),
      list: vi.fn<(...args: unknown[]) => Promise<R2Objects>>().mockResolvedValue({
        objects: [r2Object(older), r2Object(newer)],
        truncated: false,
        delimitedPrefixes: [],
      }),
    };

    const response = await handleRunnerCacheRequest(
      new Request(`https://runner.example/v1/runner-cache?key=${key}&restore_prefix=pnpm-linux-x64-node-22-`, {
        headers: { Authorization: await authorization() },
      }),
      cacheEnvironment(bucket),
      { canWriteCache: vi.fn<(runnerName: string, repository: string) => Promise<boolean>>() },
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("fallback-cache");
    expect(bucket.list).toHaveBeenCalledWith({
      prefix: "cloudflare-github-actions-runner/npm/biw%2Fexample/pnpm-linux-x64-node-22-",
      limit: 1_000,
    });
    expect(bucket.get).toHaveBeenLastCalledWith(newer.key);
  });

  it("streams uploads to R2 only after scheduler authorization", async () => {
    const key = "pnpm-linux-x64-node-22-lock";
    const bucket = {
      put: vi.fn<(...args: unknown[]) => Promise<R2Object>>().mockResolvedValue(r2Object({ key: "cache", size: 16 })),
    };
    const writeAuthorizer = {
      canWriteCache: vi.fn<(runnerName: string, repository: string) => Promise<boolean>>().mockResolvedValue(true),
    };

    const response = await handleRunnerCacheRequest(
      new Request(`https://runner.example/v1/runner-cache?key=${key}`, {
        method: "PUT",
        headers: { Authorization: await authorization() },
        body: "compressed-cache",
      }),
      cacheEnvironment(bucket),
      writeAuthorizer,
    );

    expect(response.status).toBe(201);
    expect(writeAuthorizer.canWriteCache).toHaveBeenCalledWith("cf-standard-3-job-42", "biw/example");
    expect(bucket.put).toHaveBeenCalledWith(
      runnerCacheObjectKey(claimInput.repository, key),
      expect.any(ReadableStream),
      expect.objectContaining({ customMetadata: { repository: "biw/example", runner: "cf-standard-3-job-42" } }),
    );
  });

  it("rejects cache uploads before GitHub confirms a default-branch assignment", async () => {
    const bucket = { put: vi.fn<(...args: unknown[]) => Promise<null>>() };
    const response = await handleRunnerCacheRequest(
      new Request("https://runner.example/v1/runner-cache?key=pnpm-linux-x64-node-22-lock", {
        method: "PUT",
        headers: { Authorization: await authorization() },
        body: "compressed-cache",
      }),
      cacheEnvironment(bucket),
      {
        canWriteCache: vi.fn<(runnerName: string, repository: string) => Promise<boolean>>().mockResolvedValue(false),
      },
    );

    expect(response.status).toBe(403);
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it("gives the Container an endpoint and capability, never R2 credentials", async () => {
    await expect(
      createRunnerCacheContainerConfiguration(
        { RUNNER_CACHE_SIGNING_KEY: "cache-signing-key" },
        {
          workerOrigin: "https://runner.example/ignored",
          runnerName: claimInput.runnerName,
          jobId: claimInput.jobId,
          target: { owner: "biw", repository: "example" },
          cacheScope: { scope: claimInput.scope, writeAllowed: true },
        },
      ),
    ).resolves.toMatchObject({
      endpoint: "https://runner.example/v1/runner-cache",
      authorization: expect.stringMatching(/^Bearer /u),
    });
    await expect(
      createRunnerCacheContainerConfiguration(
        { RUNNER_CACHE_SIGNING_KEY: "cache-signing-key", RUNNER_CACHE_ENABLED: "false" },
        {
          workerOrigin: "https://runner.example/ignored",
          runnerName: claimInput.runnerName,
          jobId: claimInput.jobId,
          target: { owner: "biw", repository: "example" },
          cacheScope: { scope: claimInput.scope, writeAllowed: true },
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects an uploaded archive when finalization cannot retain it within the account quota", async () => {
    const bucket = actionCacheBucket();
    const environment = cacheEnvironment(bucket);
    environment.RUNNER_CACHE_QUOTA = {
      getByName: () => ({
        recordLegacyCache: vi
          .fn<(input: CacheQuotaLegacyRecord) => Promise<CacheQuotaLegacyRecordResult>>()
          .mockResolvedValue({ retained: true }),
        commitActionCache: vi
          .fn<(input: CacheQuotaActionCommit) => Promise<CacheQuotaActionCommitResult>>()
          .mockResolvedValue({ kind: "too-large", maximumBytes: 100 }),
      }),
    };
    const headers = { Authorization: await authorization(), "Content-Type": "application/json" };
    const writeAuthorizer = {
      canWriteCache: vi.fn<(runnerName: string, repository: string) => Promise<boolean>>().mockResolvedValue(true),
    };
    const created = await handleRunnerCacheV2Request(
      new Request("https://runner.example/v1/runner-cache-v2/create", {
        method: "POST",
        headers,
        body: JSON.stringify({ key: "Linux-node-22-lock", version: "cache-version" }),
      }),
      environment,
      writeAuthorizer,
    );
    const { session } = await parseResponseJson(created, sessionResponseSchema);
    const uploaded = await handleRunnerCacheV2Request(
      new Request(`https://runner.example/v1/runner-cache-v2/upload?session=${encodeURIComponent(session)}`, {
        method: "PUT",
        headers: { Authorization: await authorization() },
        body: "cache-archive",
      }),
      environment,
      writeAuthorizer,
    );

    expect(uploaded.status).toBe(200);
    const finalized = await handleRunnerCacheV2Request(
      new Request(`https://runner.example/v1/runner-cache-v2/finalize?session=${encodeURIComponent(session)}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ key: "Linux-node-22-lock", version: "cache-version", sizeBytes: "13" }),
      }),
      environment,
      writeAuthorizer,
    );
    await expect(finalized.json()).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("configured"),
    });
  });

  it("returns a retryable JSON error when the quota controller cannot finalize an archive", async () => {
    const bucket = actionCacheBucket();
    const environment = cacheEnvironment(bucket);
    environment.RUNNER_CACHE_QUOTA = {
      getByName: () => ({
        recordLegacyCache: vi
          .fn<(input: CacheQuotaLegacyRecord) => Promise<CacheQuotaLegacyRecordResult>>()
          .mockResolvedValue({ retained: true }),
        commitActionCache: vi
          .fn<(input: CacheQuotaActionCommit) => Promise<CacheQuotaActionCommitResult>>()
          .mockRejectedValue(new Error("quota Durable Object is temporarily unavailable")),
      }),
    };
    const headers = { Authorization: await authorization(), "Content-Type": "application/json" };
    const writeAuthorizer = {
      canWriteCache: vi.fn<(runnerName: string, repository: string) => Promise<boolean>>().mockResolvedValue(true),
    };
    const created = await handleRunnerCacheV2Request(
      new Request("https://runner.example/v1/runner-cache-v2/create", {
        method: "POST",
        headers,
        body: JSON.stringify({ key: "Linux-node-22-quota-error", version: "cache-version" }),
      }),
      environment,
      writeAuthorizer,
    );
    const { session } = await parseResponseJson(created, sessionResponseSchema);
    await handleRunnerCacheV2Request(
      new Request(`https://runner.example/v1/runner-cache-v2/upload?session=${encodeURIComponent(session)}`, {
        method: "PUT",
        headers: { Authorization: await authorization() },
        body: "cache-archive",
      }),
      environment,
      writeAuthorizer,
    );

    const finalized = await handleRunnerCacheV2Request(
      new Request(`https://runner.example/v1/runner-cache-v2/finalize?session=${encodeURIComponent(session)}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ key: "Linux-node-22-quota-error", version: "cache-version", sizeBytes: "13" }),
      }),
      environment,
      writeAuthorizer,
    );

    expect(finalized.status).toBe(503);
    await expect(finalized.json()).resolves.toEqual({
      ok: false,
      message: "Could not finalize the Cloudflare R2 cache entry: quota Durable Object is temporarily unavailable",
    });
  });

  it("reports a pending JIT assignment without granting cache access", async () => {
    const bucket = actionCacheBucket();
    const environment = actionCacheEnvironment(bucket);
    const cacheAssignment = vi.fn<(runnerName: string, repository: string) => Promise<TestCacheAssignmentResult>>();
    cacheAssignment.mockResolvedValueOnce(undefined).mockResolvedValue({
      jobId: "assigned-job",
      cacheScope: { scope: "refs/pull/2/merge", writeAllowed: true },
    });
    const writeAuthorizer = {
      cacheAssignment,
    };

    const unauthorized = await handleRunnerCacheV2Request(
      new Request("https://runner.example/v1/runner-cache-v2/assignment"),
      environment,
      writeAuthorizer,
    );
    expect(unauthorized.status).toBe(401);
    expect(cacheAssignment).not.toHaveBeenCalled();

    const pending = await handleRunnerCacheV2Request(
      new Request("https://runner.example/v1/runner-cache-v2/assignment", {
        headers: { Authorization: await authorization() },
      }),
      environment,
      writeAuthorizer,
    );
    expect(pending.status).toBe(202);
    await expect(pending.json()).resolves.toEqual({ ok: false });

    const assigned = await handleRunnerCacheV2Request(
      new Request("https://runner.example/v1/runner-cache-v2/assignment", {
        headers: { Authorization: await authorization() },
      }),
      environment,
      writeAuthorizer,
    );
    expect(assigned.status).toBe(200);
    await expect(assigned.json()).resolves.toEqual({ ok: true });
  });

  it("implements CacheService v2 lookups and direct archive uploads in R2", async () => {
    const bucket = actionCacheBucket();
    const environment = actionCacheEnvironment(bucket);
    const writeAuthorizer = {
      canWriteCache: vi.fn<(runnerName: string, repository: string) => Promise<boolean>>().mockResolvedValue(true),
    };
    const headers = { Authorization: await authorization(), "Content-Type": "application/json" };

    const created = await handleRunnerCacheV2Request(
      new Request("https://runner.example/v1/runner-cache-v2/create", {
        method: "POST",
        headers,
        body: JSON.stringify({ key: "Linux-node-22-lock", version: "cache-version" }),
      }),
      environment,
      writeAuthorizer,
    );
    const { ok: createdOk, session } = await parseResponseJson(
      created,
      sessionResponseSchema.extend({ ok: z.boolean() }),
    );
    expect(createdOk).toBe(true);
    expect(session).toEqual(expect.any(String));

    const uploaded = await handleRunnerCacheV2Request(
      new Request(`https://runner.example/v1/runner-cache-v2/upload?session=${encodeURIComponent(session)}`, {
        method: "PUT",
        headers: { Authorization: await authorization() },
        body: "cache-archive",
      }),
      environment,
      writeAuthorizer,
    );
    expect(uploaded.status).toBe(200);

    const finalizeRequest = () =>
      new Request(`https://runner.example/v1/runner-cache-v2/finalize?session=${encodeURIComponent(session)}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ key: "Linux-node-22-lock", version: "cache-version", sizeBytes: "13" }),
      });
    const finalized = await handleRunnerCacheV2Request(finalizeRequest(), environment, writeAuthorizer);
    await expect(finalized.json()).resolves.toMatchObject({ ok: true, entryId: expect.any(String) });

    // CacheService retries a finalize RPC when its prior response is lost. It
    // must preserve the archive rather than treating that retry as a loser.
    const retry = await handleRunnerCacheV2Request(finalizeRequest(), environment, writeAuthorizer);
    await expect(retry.json()).resolves.toMatchObject({ ok: true, entryId: expect.any(String) });

    const lookup = await handleRunnerCacheV2Request(
      new Request("https://runner.example/v1/runner-cache-v2/lookup", {
        method: "POST",
        headers,
        body: JSON.stringify({ key: "Linux-node-22-lock", restoreKeys: [], version: "cache-version" }),
      }),
      environment,
      writeAuthorizer,
    );
    const hit = await parseResponseJson(lookup, matchedCacheHitResponseSchema);
    expect(hit).toMatchObject({ ok: true, matchedKey: "Linux-node-22-lock" });

    const archive = await handleRunnerCacheV2Request(new Request(hit.signedDownloadUrl), environment, writeAuthorizer);
    await expect(archive.text()).resolves.toBe("cache-archive");
    expect(writeAuthorizer.canWriteCache).toHaveBeenCalled();
  });

  it("does not allow a valid capability from another runner to use an upload session", async () => {
    const bucket = actionCacheBucket();
    const environment = actionCacheEnvironment(bucket);
    const writeAuthorizer = {
      canWriteCache: vi.fn<(runnerName: string, repository: string) => Promise<boolean>>().mockResolvedValue(true),
    };
    const headers = { Authorization: await authorization(), "Content-Type": "application/json" };
    const created = await handleRunnerCacheV2Request(
      new Request("https://runner.example/v1/runner-cache-v2/create", {
        method: "POST",
        headers,
        body: JSON.stringify({ key: "Linux-node-22-session", version: "cache-version" }),
      }),
      environment,
      writeAuthorizer,
    );
    const { session } = await parseResponseJson(created, sessionResponseSchema);
    const otherCapability = await authorization({
      ...claimInput,
      runnerName: "cf-standard-3-job-43",
      jobId: "43",
    });

    const upload = await handleRunnerCacheV2Request(
      new Request(`https://runner.example/v1/runner-cache-v2/upload?session=${encodeURIComponent(session)}`, {
        method: "PUT",
        headers: { Authorization: otherCapability },
        body: "stolen-cache",
      }),
      environment,
      writeAuthorizer,
    );
    expect(upload.status).toBe(401);
    await expect(upload.json()).resolves.toEqual({ error: "Unauthorized cache upload session" });

    const finalize = await handleRunnerCacheV2Request(
      new Request(`https://runner.example/v1/runner-cache-v2/finalize?session=${encodeURIComponent(session)}`, {
        method: "POST",
        headers: { Authorization: otherCapability, "Content-Type": "application/json" },
        body: JSON.stringify({ key: "Linux-node-22-session", version: "cache-version", sizeBytes: "12" }),
      }),
      environment,
      writeAuthorizer,
    );
    expect(finalize.status).toBe(401);
    await expect(finalize.json()).resolves.toEqual({ ok: false, message: "Invalid cache finalize session" });
    expect(bucket.resumeMultipartUpload).not.toHaveBeenCalled();
  });

  it("isolates pull-request writes to its merge ref while falling back to the default branch", async () => {
    const bucket = actionCacheBucket();
    const environment = actionCacheEnvironment(bucket);
    const pullRequestClaim = {
      runnerName: "cf-standard-3-job-43",
      jobId: "43",
      repository: claimInput.repository,
      scope: "refs/pull/2/merge",
      fallbackScope: claimInput.scope,
    };
    const writeAuthorizer = {
      cacheScope: vi
        .fn<
          (
            runnerName: string,
            repository: string,
            jobId: string,
          ) => Promise<{
            scope: string;
            fallbackScope?: string;
            writeAllowed: boolean;
          }>
        >()
        .mockImplementation(async (_runnerName, _repository, jobId) =>
          jobId === pullRequestClaim.jobId
            ? {
                scope: pullRequestClaim.scope,
                fallbackScope: pullRequestClaim.fallbackScope,
                writeAllowed: true,
              }
            : { scope: claimInput.scope, writeAllowed: true },
        ),
    };
    const key = "Linux-node-22-lock";
    const version = "cache-version";

    const defaultHeaders = { Authorization: await authorization(), "Content-Type": "application/json" };
    const defaultCreated = await handleRunnerCacheV2Request(
      new Request("https://runner.example/v1/runner-cache-v2/create", {
        method: "POST",
        headers: defaultHeaders,
        body: JSON.stringify({ key, version }),
      }),
      environment,
      writeAuthorizer,
    );
    const { session: defaultSession } = await parseResponseJson(defaultCreated, sessionResponseSchema);
    await handleRunnerCacheV2Request(
      new Request(`https://runner.example/v1/runner-cache-v2/upload?session=${encodeURIComponent(defaultSession)}`, {
        method: "PUT",
        headers: { Authorization: await authorization() },
        body: "default-branch-cache",
      }),
      environment,
      writeAuthorizer,
    );
    await handleRunnerCacheV2Request(
      new Request(`https://runner.example/v1/runner-cache-v2/finalize?session=${encodeURIComponent(defaultSession)}`, {
        method: "POST",
        headers: defaultHeaders,
        body: JSON.stringify({ key, version, sizeBytes: "20" }),
      }),
      environment,
      writeAuthorizer,
    );

    const pullRequestAuthorization = await authorization(pullRequestClaim);
    const pullRequestHeaders = { Authorization: pullRequestAuthorization, "Content-Type": "application/json" };
    const fallbackLookup = await handleRunnerCacheV2Request(
      new Request("https://runner.example/v1/runner-cache-v2/lookup", {
        method: "POST",
        headers: pullRequestHeaders,
        body: JSON.stringify({ key, version, restoreKeys: [] }),
      }),
      environment,
      writeAuthorizer,
    );
    const fallback = await parseResponseJson(fallbackLookup, cacheHitResponseSchema);
    expect(fallback.ok).toBe(true);
    await expect(
      handleRunnerCacheV2Request(new Request(fallback.signedDownloadUrl), environment, writeAuthorizer).then(
        (response) => response.text(),
      ),
    ).resolves.toBe("default-branch-cache");

    const pullRequestCreated = await handleRunnerCacheV2Request(
      new Request("https://runner.example/v1/runner-cache-v2/create", {
        method: "POST",
        headers: pullRequestHeaders,
        body: JSON.stringify({ key, version }),
      }),
      environment,
      writeAuthorizer,
    );
    await expect(pullRequestCreated.json()).resolves.toMatchObject({ ok: true, session: expect.any(String) });
  });

  it("uses the actual JIT runner assignment when GitHub swaps compatible jobs", async () => {
    const bucket = actionCacheBucket();
    const environment = actionCacheEnvironment(bucket);
    const actualJob = {
      jobId: "99",
      cacheScope: {
        scope: "refs/pull/2/merge",
        fallbackScope: claimInput.scope,
        writeAllowed: true,
      },
    };
    const writeAuthorizer = {
      cacheAssignment: vi
        .fn<
          (
            runnerName: string,
            repository: string,
          ) => Promise<{
            jobId: string;
            cacheScope: { scope: string; fallbackScope: string; writeAllowed: boolean };
          }>
        >()
        .mockResolvedValue(actualJob),
    };
    const headers = { Authorization: await authorization(), "Content-Type": "application/json" };
    const key = "Linux-node-22-swapped-job";
    const version = "cache-version";

    const created = await handleRunnerCacheV2Request(
      new Request("https://runner.example/v1/runner-cache-v2/create", {
        method: "POST",
        headers,
        body: JSON.stringify({ key, version }),
      }),
      environment,
      writeAuthorizer,
    );
    const { session } = await parseResponseJson(created, sessionResponseSchema);
    await handleRunnerCacheV2Request(
      new Request(`https://runner.example/v1/runner-cache-v2/upload?session=${encodeURIComponent(session)}`, {
        method: "PUT",
        headers: { Authorization: await authorization() },
        body: "swapped-job-cache",
      }),
      environment,
      writeAuthorizer,
    );
    await handleRunnerCacheV2Request(
      new Request(`https://runner.example/v1/runner-cache-v2/finalize?session=${encodeURIComponent(session)}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ key, version, sizeBytes: "17" }),
      }),
      environment,
      writeAuthorizer,
    );

    const lookup = await handleRunnerCacheV2Request(
      new Request("https://runner.example/v1/runner-cache-v2/lookup", {
        method: "POST",
        headers,
        body: JSON.stringify({ key, version, restoreKeys: [] }),
      }),
      environment,
      writeAuthorizer,
    );
    const hit = await parseResponseJson(lookup, cacheHitResponseSchema);
    expect(hit.ok).toBe(true);
    await expect(
      handleRunnerCacheV2Request(new Request(hit.signedDownloadUrl), environment, writeAuthorizer).then((response) =>
        response.text(),
      ),
    ).resolves.toBe("swapped-job-cache");
    expect(writeAuthorizer.cacheAssignment).toHaveBeenCalledWith("cf-standard-3-job-42", "biw/example");
  });

  it("keeps two crossed JIT runners in their separately assigned pull-request cache scopes", async () => {
    const bucket = actionCacheBucket();
    const environment = actionCacheEnvironment(bucket);
    const firstRunner = {
      runnerName: "cf-standard-3-job-100",
      jobId: "100",
      repository: "biw/example",
      scope: "refs/pull/100/merge",
    };
    const secondRunner = {
      runnerName: "cf-standard-3-job-200",
      jobId: "200",
      repository: "biw/example",
      scope: "refs/pull/200/merge",
    };
    // Runner 100 was created for job 100 but GitHub assigned it job 200; the
    // other runner received job 100. The signed runner capability deliberately
    // still has each runner's source job so this exercises the Worker-side
    // assignment lookup which fixes the real race.
    const assignments = new Map<
      string,
      { jobId: string; cacheScope: { scope: string; fallbackScope: string; writeAllowed: boolean } }
    >([
      [
        firstRunner.runnerName,
        {
          jobId: secondRunner.jobId,
          cacheScope: { scope: secondRunner.scope, fallbackScope: "refs/heads/main", writeAllowed: true },
        },
      ],
      [
        secondRunner.runnerName,
        {
          jobId: firstRunner.jobId,
          cacheScope: { scope: firstRunner.scope, fallbackScope: "refs/heads/main", writeAllowed: true },
        },
      ],
    ]);
    const writeAuthorizer = {
      cacheAssignment: vi
        .fn<
          (
            runnerName: string,
            repository: string,
          ) => Promise<
            { jobId: string; cacheScope: { scope: string; fallbackScope: string; writeAllowed: boolean } } | undefined
          >
        >()
        .mockImplementation(async (runnerName) => assignments.get(runnerName)),
    };
    const key = "Linux-node-22-crossed-runners";
    const version = "cache-version";

    const save = async (runner: typeof firstRunner, content: string): Promise<void> => {
      const token = await authorization(runner);
      const headers = { Authorization: token, "Content-Type": "application/json" };
      const created = await handleRunnerCacheV2Request(
        new Request("https://runner.example/v1/runner-cache-v2/create", {
          method: "POST",
          headers,
          body: JSON.stringify({ key, version }),
        }),
        environment,
        writeAuthorizer,
      );
      const { ok, session } = await parseResponseJson(created, sessionResponseSchema.extend({ ok: z.boolean() }));
      expect(ok).toBe(true);
      const uploaded = await handleRunnerCacheV2Request(
        new Request(`https://runner.example/v1/runner-cache-v2/upload?session=${encodeURIComponent(session)}`, {
          method: "PUT",
          headers: { Authorization: token },
          body: content,
        }),
        environment,
        writeAuthorizer,
      );
      expect(uploaded.status).toBe(200);
      const finalized = await handleRunnerCacheV2Request(
        new Request(`https://runner.example/v1/runner-cache-v2/finalize?session=${encodeURIComponent(session)}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ key, version, sizeBytes: String(content.length) }),
        }),
        environment,
        writeAuthorizer,
      );
      await expect(finalized.json()).resolves.toMatchObject({ ok: true });
    };

    const restore = async (runner: typeof firstRunner): Promise<string> => {
      const headers = {
        Authorization: await authorization(runner),
        "Content-Type": "application/json",
      };
      const lookup = await handleRunnerCacheV2Request(
        new Request("https://runner.example/v1/runner-cache-v2/lookup", {
          method: "POST",
          headers,
          body: JSON.stringify({ key, version, restoreKeys: [] }),
        }),
        environment,
        writeAuthorizer,
      );
      const hit = await parseResponseJson(lookup, cacheHitResponseSchema);
      expect(hit.ok).toBe(true);
      return handleRunnerCacheV2Request(new Request(hit.signedDownloadUrl), environment, writeAuthorizer).then(
        (response) => response.text(),
      );
    };

    await save(firstRunner, "cache-for-github-job-200");
    await save(secondRunner, "cache-for-github-job-100");

    await expect(restore(firstRunner)).resolves.toBe("cache-for-github-job-200");
    await expect(restore(secondRunner)).resolves.toBe("cache-for-github-job-100");
    expect(writeAuthorizer.cacheAssignment).toHaveBeenCalledWith(firstRunner.runnerName, firstRunner.repository);
    expect(writeAuthorizer.cacheAssignment).toHaveBeenCalledWith(secondRunner.runnerName, secondRunner.repository);
  });

  it("accepts Azure-style multipart uploads used by actions/cache archives over 128 MiB", async () => {
    const bucket = actionCacheBucket();
    const environment = actionCacheEnvironment(bucket);
    const writeAuthorizer = {
      canWriteCache: vi.fn<(runnerName: string, repository: string) => Promise<boolean>>().mockResolvedValue(true),
    };
    const headers = { Authorization: await authorization(), "Content-Type": "application/json" };
    const key = "Linux-node-22-multipart";
    const version = "cache-version";
    const created = await handleRunnerCacheV2Request(
      new Request("https://runner.example/v1/runner-cache-v2/create", {
        method: "POST",
        headers,
        body: JSON.stringify({ key, version }),
      }),
      environment,
      writeAuthorizer,
    );
    const { session } = await parseResponseJson(created, sessionResponseSchema);
    const blockIds = [btoa("cache".padEnd(48, "0")), btoa("cache".padEnd(47, "0") + "1")];
    const uploadAuthorization = await authorization();
    const uploaded = await Promise.all(
      ["first-", "second"].map(async (body, index) => ({
        index,
        response: await handleRunnerCacheV2Request(
          new Request(
            `https://runner.example/v1/runner-cache-v2/upload?session=${encodeURIComponent(session)}&block_id=${encodeURIComponent(blockIds[index])}`,
            { method: "PUT", headers: { Authorization: uploadAuthorization }, body },
          ),
          environment,
          writeAuthorizer,
        ),
      })),
    );
    await Promise.all(
      uploaded.map(({ index, response }) =>
        expect(response.json()).resolves.toMatchObject({
          ok: true,
          partNumber: index + 1,
          etag: `etag-${index + 1}`,
        }),
      ),
    );

    const completed = await handleRunnerCacheV2Request(
      new Request(`https://runner.example/v1/runner-cache-v2/complete?session=${encodeURIComponent(session)}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          parts: blockIds.map((blockId, index) => ({ blockId, partNumber: index + 1, etag: `etag-${index + 1}` })),
        }),
      }),
      environment,
      writeAuthorizer,
    );
    await expect(completed.json()).resolves.toEqual({ ok: true });

    const finalized = await handleRunnerCacheV2Request(
      new Request(`https://runner.example/v1/runner-cache-v2/finalize?session=${encodeURIComponent(session)}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ key, version, sizeBytes: "12" }),
      }),
      environment,
      writeAuthorizer,
    );
    await expect(finalized.json()).resolves.toMatchObject({ ok: true, entryId: "1" });

    const lookup = await handleRunnerCacheV2Request(
      new Request("https://runner.example/v1/runner-cache-v2/lookup", {
        method: "POST",
        headers,
        body: JSON.stringify({ key, restoreKeys: [], version }),
      }),
      environment,
      writeAuthorizer,
    );
    const hit = await parseResponseJson(lookup, z.object({ signedDownloadUrl: z.string() }));
    const archive = await handleRunnerCacheV2Request(new Request(hit.signedDownloadUrl), environment, writeAuthorizer);
    await expect(archive.text()).resolves.toBe("first-second");
  });

  it("returns a JSON cache-save error when R2 rejects multipart completion", async () => {
    const bucket = actionCacheBucket();
    const environment = actionCacheEnvironment(bucket);
    const writeAuthorizer = {
      canWriteCache: vi.fn<(runnerName: string, repository: string) => Promise<boolean>>().mockResolvedValue(true),
    };
    const headers = { Authorization: await authorization(), "Content-Type": "application/json" };
    const key = "Linux-node-22-multipart-error";
    const version = "cache-version";
    const created = await handleRunnerCacheV2Request(
      new Request("https://runner.example/v1/runner-cache-v2/create", {
        method: "POST",
        headers,
        body: JSON.stringify({ key, version }),
      }),
      environment,
      writeAuthorizer,
    );
    const { session } = await parseResponseJson(created, sessionResponseSchema);
    const blockId = btoa("cloudflare-cache-000000");
    await handleRunnerCacheV2Request(
      new Request(
        `https://runner.example/v1/runner-cache-v2/upload?session=${encodeURIComponent(session)}&block_id=${encodeURIComponent(blockId)}`,
        { method: "PUT", headers: { Authorization: await authorization() }, body: "cache-part" },
      ),
      environment,
      writeAuthorizer,
    );
    vi.mocked(bucket.resumeMultipartUpload).mockImplementationOnce((objectKey, uploadId) =>
      r2MultipartUpload({
        key: objectKey,
        uploadId,
        complete: vi
          .fn<() => Promise<R2Object>>()
          .mockRejectedValue(new Error("The multipart upload no longer exists")),
      }),
    );

    const completed = await handleRunnerCacheV2Request(
      new Request(`https://runner.example/v1/runner-cache-v2/complete?session=${encodeURIComponent(session)}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ parts: [{ blockId, partNumber: 1, etag: "etag-1" }] }),
      }),
      environment,
      writeAuthorizer,
    );

    expect(completed.status).toBe(502);
    await expect(completed.json()).resolves.toEqual({ error: "Could not complete the Cloudflare R2 cache archive" });
  });
});
