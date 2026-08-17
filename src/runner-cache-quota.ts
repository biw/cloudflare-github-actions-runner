import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import type { WorkerEnvironment } from "./environment";
import {
  runnerCacheArchivePrefix,
  runnerCacheLegacyPrefix,
  runnerCacheManifestPrefix,
  runnerCacheMaxBytes,
  runnerCachePrefix,
  type ActionCacheManifest,
  type CacheQuotaActionCommit,
  type CacheQuotaActionCommitResult,
  type CacheQuotaLegacyRecord,
  type CacheQuotaLegacyRecordResult,
} from "./runner-cache";

interface CacheEntryRow {
  [column: string]: ArrayBuffer | number | string | null;
  entry_key: string;
  archive_key: string;
  manifest_key: string | null;
  size_bytes: number;
  created_at: number;
}

const actionCacheManifestSchema: z.ZodType<ActionCacheManifest> = z.object({
  entryId: z.string(),
  cacheKey: z.string(),
  cacheVersion: z.string(),
  objectKey: z.string(),
  createdAt: z.number().int().positive(),
});

/**
 * Serializes cache bookkeeping for one runner-pool account. R2 has no
 * bucket-size cap, so this object owns the user-selected quota and evicts the
 * oldest managed cache entries first. Its SQLite table is an index only; R2
 * remains the archive source of truth and is rebuilt once when needed.
 */
export class RunnerCacheQuota extends DurableObject<WorkerEnvironment> {
  private tail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: WorkerEnvironment) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS runner_cache_entries (
          entry_key TEXT PRIMARY KEY,
          archive_key TEXT NOT NULL,
          manifest_key TEXT,
          size_bytes INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS runner_cache_entries_created_at
          ON runner_cache_entries(created_at, entry_key);
        CREATE TABLE IF NOT EXISTS runner_cache_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    });
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: (() => void) | undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  private indexIsReady(): boolean {
    const [metadata] = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM runner_cache_metadata WHERE key = 'index_ready'")
      .toArray();
    return metadata?.value === "true";
  }

  private async ensureIndex(): Promise<void> {
    if (this.indexIsReady()) {
      return;
    }

    const manifests = new Map<string, R2Object>();
    const archives = new Map<string, R2Object>();
    const legacyObjects: R2Object[] = [];
    let cursor: string | undefined;
    const manifestPrefix = runnerCacheManifestPrefix(this.env);
    const archivePrefix = runnerCacheArchivePrefix(this.env);
    const legacyPrefix = runnerCacheLegacyPrefix(this.env);
    do {
      // eslint-disable-next-line no-await-in-loop -- R2 cursors must be consumed in order.
      const listed = await this.env.RUNNER_CACHE.list({
        prefix: `${runnerCachePrefix(this.env)}/`,
        cursor,
        limit: 1_000,
      });
      for (const object of listed.objects) {
        if (object.key.startsWith(manifestPrefix) && object.key.endsWith(".json")) {
          manifests.set(object.key, object);
        } else if (object.key.startsWith(archivePrefix)) {
          archives.set(object.key, object);
        } else if (object.key.startsWith(legacyPrefix)) {
          legacyObjects.push(object);
        }
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor !== undefined);

    for (const object of legacyObjects) {
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO runner_cache_entries (entry_key, archive_key, manifest_key, size_bytes, created_at)
         VALUES (?, ?, NULL, ?, ?)`,
        `legacy:${object.key}`,
        object.key,
        object.size,
        object.uploaded.getTime(),
      );
    }

    for (const [manifestKey, listedManifest] of manifests) {
      // eslint-disable-next-line no-await-in-loop -- manifest validation controls the associated archive entry.
      const manifestObject = await this.env.RUNNER_CACHE.get(manifestKey);
      if (manifestObject === null) {
        continue;
      }
      let manifest;
      try {
        // eslint-disable-next-line no-await-in-loop -- one R2 manifest is parsed at a time.
        const parsedManifest = actionCacheManifestSchema.safeParse(await manifestObject.json<z.core.util.JSONType>());
        if (!parsedManifest.success) {
          continue;
        }
        manifest = parsedManifest.data;
      } catch {
        continue;
      }
      if (!manifest.objectKey.startsWith(archivePrefix)) {
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- each manifest has one archive to verify.
      const archive = await this.env.RUNNER_CACHE.head(manifest.objectKey);
      if (archive === null) {
        continue;
      }
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO runner_cache_entries (entry_key, archive_key, manifest_key, size_bytes, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        `action:${manifestKey}`,
        manifest.objectKey,
        listedManifest.key,
        archive.size,
        manifest.createdAt,
      );
      archives.delete(manifest.objectKey);
    }

    for (const archive of archives.values()) {
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO runner_cache_entries (entry_key, archive_key, manifest_key, size_bytes, created_at)
         VALUES (?, ?, NULL, ?, ?)`,
        `pending:${archive.key}`,
        archive.key,
        archive.size,
        archive.uploaded.getTime(),
      );
    }

    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO runner_cache_metadata (key, value) VALUES ('index_ready', 'true')",
    );
  }

  private totalBytes(): number {
    const [row] = this.ctx.storage.sql
      .exec<{ total: number | null }>("SELECT COALESCE(SUM(size_bytes), 0) AS total FROM runner_cache_entries")
      .toArray();
    return row?.total ?? 0;
  }

  private oldestEntry(): CacheEntryRow | undefined {
    const [entry] = this.ctx.storage.sql
      .exec<CacheEntryRow>(
        "SELECT entry_key, archive_key, manifest_key, size_bytes, created_at FROM runner_cache_entries ORDER BY created_at, entry_key LIMIT 1",
      )
      .toArray();
    return entry;
  }

  private async enforceQuota(): Promise<void> {
    const maximum = runnerCacheMaxBytes(this.env);
    let total = this.totalBytes();
    while (total > maximum) {
      const oldest = this.oldestEntry();
      if (oldest === undefined) {
        return;
      }
      // R2's batch delete is atomic per request; a cache restore that races
      // this removal sees a normal cache miss and falls back to installation.
      // eslint-disable-next-line no-await-in-loop -- FIFO eviction must finish before selecting the next oldest entry.
      await this.env.RUNNER_CACHE.delete(
        oldest.manifest_key === null ? oldest.archive_key : [oldest.archive_key, oldest.manifest_key],
      );
      this.ctx.storage.sql.exec("DELETE FROM runner_cache_entries WHERE entry_key = ?", oldest.entry_key);
      total -= oldest.size_bytes;
    }
  }

  async recordLegacyCache(input: CacheQuotaLegacyRecord): Promise<CacheQuotaLegacyRecordResult> {
    return this.serialize(async () => {
      await this.ensureIndex();
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO runner_cache_entries (entry_key, archive_key, manifest_key, size_bytes, created_at)
         VALUES (?, ?, NULL, ?, ?)`,
        `legacy:${input.objectKey}`,
        input.objectKey,
        input.sizeBytes,
        input.createdAt,
      );
      await this.enforceQuota();
      const [retainedEntry] = this.ctx.storage.sql
        .exec<{ entry_key: string }>(
          "SELECT entry_key FROM runner_cache_entries WHERE entry_key = ?",
          `legacy:${input.objectKey}`,
        )
        .toArray();
      const retained = retainedEntry !== undefined;
      return { retained };
    });
  }

  async commitActionCache(input: CacheQuotaActionCommit): Promise<CacheQuotaActionCommitResult> {
    return this.serialize(async () => {
      await this.ensureIndex();
      const maximum = runnerCacheMaxBytes(this.env);
      if (input.sizeBytes > maximum) {
        await this.env.RUNNER_CACHE.delete(input.manifest.objectKey);
        this.ctx.storage.sql.exec(
          "DELETE FROM runner_cache_entries WHERE entry_key = ?",
          `pending:${input.manifest.objectKey}`,
        );
        return { kind: "too-large", maximumBytes: maximum };
      }
      const stored = await this.env.RUNNER_CACHE.put(input.manifestKey, JSON.stringify(input.manifest), {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json" },
        customMetadata: input.customMetadata,
      });
      if (stored === null) {
        // CacheService may retry finalization after the first response is
        // lost. That retry has the same multipart archive but a newly-created
        // manifest payload. Treat it as success without deleting the archive
        // which the first finalization already committed. A genuinely
        // concurrent save has a different archive and is still discarded.
        const existingObject = await this.env.RUNNER_CACHE.get(input.manifestKey);
        if (existingObject !== null) {
          try {
            const existing = actionCacheManifestSchema.safeParse(await existingObject.json<z.core.util.JSONType>());
            if (existing.success && existing.data.objectKey === input.manifest.objectKey) {
              return { kind: "stored" };
            }
          } catch {
            // A malformed existing object cannot be a successful finalization;
            // continue with the normal losing-writer cleanup below.
          }
        }
        await this.env.RUNNER_CACHE.delete(input.manifest.objectKey);
        this.ctx.storage.sql.exec(
          "DELETE FROM runner_cache_entries WHERE entry_key = ?",
          `pending:${input.manifest.objectKey}`,
        );
        return { kind: "already-exists" };
      }
      this.ctx.storage.sql.exec(
        "DELETE FROM runner_cache_entries WHERE entry_key = ?",
        `pending:${input.manifest.objectKey}`,
      );
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO runner_cache_entries (entry_key, archive_key, manifest_key, size_bytes, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        `action:${input.manifestKey}`,
        input.manifest.objectKey,
        input.manifestKey,
        input.sizeBytes,
        input.manifest.createdAt,
      );
      await this.enforceQuota();
      return { kind: "stored" };
    });
  }
}
