import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vite-plus/test";

const cachePrefix = "cloudflare-github-actions-runner";
const archivePrefix = `${cachePrefix}/actions-cache-v2/archives/`;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function actionInput(
  id: string,
  content: string,
  createdAt: number,
  manifestKey = `${cachePrefix}/actions-cache-v2/${id}.json`,
) {
  const archiveKey = `${archivePrefix}${id}.tar.zst`;
  return {
    archiveKey,
    content,
    input: {
      manifestKey,
      manifest: {
        entryId: id,
        cacheKey: `Linux-node-22-${id}`,
        cacheVersion: "cache-version",
        objectKey: archiveKey,
        createdAt,
      },
      sizeBytes: byteLength(content),
      customMetadata: { repository: "biw/runner-poc", cacheVersion: "cache-version" },
    },
  };
}

async function clearR2Cache(): Promise<void> {
  let cursor: string | undefined;
  do {
    // eslint-disable-next-line no-await-in-loop -- paginated R2 cursors must be consumed in order.
    const listed = await env.RUNNER_CACHE.list({ prefix: `${cachePrefix}/`, cursor, limit: 1_000 });
    if (listed.objects.length > 0) {
      // eslint-disable-next-line no-await-in-loop -- delete each cursor page before requesting the next page.
      await env.RUNNER_CACHE.delete(listed.objects.map((object) => object.key));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
}

describe("RunnerCacheQuota", () => {
  beforeEach(clearR2Cache);

  it("initializes an empty quota index before finalizing the first R2 archive", async () => {
    const quota = env.RUNNER_CACHE_QUOTA.getByName("empty-index-regression");
    const first = actionInput("first", "first archive", Date.now());
    await env.RUNNER_CACHE.put(first.archiveKey, first.content);

    await expect(quota.commitActionCache(first.input)).resolves.toEqual({ kind: "stored" });

    await expect(env.RUNNER_CACHE.get(first.input.manifestKey).then((object) => object?.json())).resolves.toMatchObject(
      {
        objectKey: first.archiveKey,
      },
    );
  });

  it("evicts the oldest finalized archive and its manifest when the account FIFO quota is exceeded", async () => {
    const quota = env.RUNNER_CACHE_QUOTA.getByName("fifo-eviction");
    const oldest = actionInput("oldest", "first-entry", 1);
    const newest = actionInput("newest", "second-entry", 2);
    await env.RUNNER_CACHE.put(oldest.archiveKey, oldest.content);
    await expect(quota.commitActionCache(oldest.input)).resolves.toEqual({ kind: "stored" });
    await env.RUNNER_CACHE.put(newest.archiveKey, newest.content);
    await expect(quota.commitActionCache(newest.input)).resolves.toEqual({ kind: "stored" });

    await expect(env.RUNNER_CACHE.head(oldest.archiveKey)).resolves.toBeNull();
    await expect(env.RUNNER_CACHE.head(oldest.input.manifestKey)).resolves.toBeNull();
    await expect(env.RUNNER_CACHE.head(newest.archiveKey)).resolves.toMatchObject({ key: newest.archiveKey });
    await expect(env.RUNNER_CACHE.head(newest.input.manifestKey)).resolves.toMatchObject({
      key: newest.input.manifestKey,
    });
  });

  it("removes an archive that alone exceeds the configured quota without creating a manifest", async () => {
    const quota = env.RUNNER_CACHE_QUOTA.getByName("oversized-entry");
    const oversized = actionInput("oversized", "x".repeat(21), 1);
    await env.RUNNER_CACHE.put(oversized.archiveKey, oversized.content);

    await expect(quota.commitActionCache(oversized.input)).resolves.toEqual({ kind: "too-large", maximumBytes: 20 });
    await expect(env.RUNNER_CACHE.head(oversized.archiveKey)).resolves.toBeNull();
    await expect(env.RUNNER_CACHE.head(oversized.input.manifestKey)).resolves.toBeNull();
  });

  it("makes retrying a successful finalization idempotent without deleting its live archive", async () => {
    const quota = env.RUNNER_CACHE_QUOTA.getByName("idempotent-finalization");
    const entry = actionInput("retry", "retry-entry", 1);
    await env.RUNNER_CACHE.put(entry.archiveKey, entry.content);

    await expect(quota.commitActionCache(entry.input)).resolves.toEqual({ kind: "stored" });
    await expect(
      quota.commitActionCache({
        ...entry.input,
        // The worker creates a fresh manifest payload when CacheService retries
        // the finalize RPC, but the multipart archive is unchanged.
        manifest: { ...entry.input.manifest, entryId: "retry-after-lost-response", createdAt: 2 },
      }),
    ).resolves.toEqual({ kind: "stored" });

    await expect(env.RUNNER_CACHE.get(entry.archiveKey).then((object) => object?.text())).resolves.toBe(entry.content);
    await expect(env.RUNNER_CACHE.get(entry.input.manifestKey).then((object) => object?.json())).resolves.toMatchObject(
      {
        objectKey: entry.archiveKey,
        entryId: "retry",
      },
    );
  });

  it("allows only one concurrent cache creator for a cache key and cleans up the losing archive", async () => {
    const quota = env.RUNNER_CACHE_QUOTA.getByName("concurrent-finalization");
    const manifestKey = `${cachePrefix}/actions-cache-v2/same-key.json`;
    const first = actionInput("first-writer", "first", 1, manifestKey);
    const second = actionInput("second-writer", "second", 2, manifestKey);
    await env.RUNNER_CACHE.put(first.archiveKey, first.content);
    await env.RUNNER_CACHE.put(second.archiveKey, second.content);

    const results = await Promise.all([quota.commitActionCache(first.input), quota.commitActionCache(second.input)]);
    expect(results).toEqual(expect.arrayContaining([{ kind: "stored" }, { kind: "already-exists" }]));

    const manifest = await env.RUNNER_CACHE.get(manifestKey).then((object) => object?.json<{ objectKey: string }>());
    expect(manifest).toBeDefined();
    const winner = manifest?.objectKey;
    expect([first.archiveKey, second.archiveKey]).toContain(winner);
    await expect(env.RUNNER_CACHE.head(winner ?? "missing")).resolves.not.toBeNull();
    await expect(
      env.RUNNER_CACHE.head(winner === first.archiveKey ? second.archiveKey : first.archiveKey),
    ).resolves.toBeNull();
  });

  it("rebuilds a missing Durable Object index from R2 before applying FIFO eviction", async () => {
    const quota = env.RUNNER_CACHE_QUOTA.getByName("r2-index-recovery");
    const recovered = actionInput("recovered", "recovered-old", 1);
    const laterLegacyKey = `${cachePrefix}/npm/biw%2Frunner-poc/later-cache.tar.zst`;
    const laterLegacy = "later-legacy";
    await env.RUNNER_CACHE.put(recovered.archiveKey, recovered.content);
    await env.RUNNER_CACHE.put(recovered.input.manifestKey, JSON.stringify(recovered.input.manifest));
    await env.RUNNER_CACHE.put(laterLegacyKey, laterLegacy);

    await expect(
      quota.recordLegacyCache({
        objectKey: laterLegacyKey,
        sizeBytes: byteLength(laterLegacy),
        createdAt: 2,
      }),
    ).resolves.toEqual({ retained: true });

    await expect(env.RUNNER_CACHE.head(recovered.archiveKey)).resolves.toBeNull();
    await expect(env.RUNNER_CACHE.head(recovered.input.manifestKey)).resolves.toBeNull();
    await expect(env.RUNNER_CACHE.get(laterLegacyKey).then((object) => object?.text())).resolves.toBe(laterLegacy);
  });
});
