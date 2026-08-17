import { randomUUID } from "node:crypto";

import { z } from "zod";

export const runnerOwnershipManagedBy = "cloudflare-github-actions-runner";
export const runnerOwnershipManifestVersion = 1;

const nonEmptyStringSchema = z.string().trim().min(1);
const ownedNamedResourceSchema = z.object({ name: nonEmptyStringSchema });
const ownedIdentifiedResourceSchema = ownedNamedResourceSchema.extend({ id: nonEmptyStringSchema });
const runnerOwnershipManifestSchema = z.object({
  version: z.literal(runnerOwnershipManifestVersion),
  installationId: z.uuid(),
  accountId: z.string().length(32),
  githubOwner: nonEmptyStringSchema,
  worker: ownedNamedResourceSchema,
  applications: z.array(ownedIdentifiedResourceSchema),
  pendingApplications: z.array(ownedNamedResourceSchema).default([]),
  workflows: z.array(ownedIdentifiedResourceSchema),
  pendingWorkflows: z.array(ownedNamedResourceSchema).default([]),
  database: ownedIdentifiedResourceSchema,
  bucket: ownedNamedResourceSchema.extend({ prefixes: z.array(nonEmptyStringSchema).min(1) }),
  images: z.array(z.object({ reference: nonEmptyStringSchema })),
  cloudflareToken: z.object({ id: z.string().length(32) }).optional(),
  githubApp: z
    .object({ id: z.number().int().positive(), slug: nonEmptyStringSchema, owner: nonEmptyStringSchema })
    .optional(),
});

export type RunnerOwnershipManifest = z.infer<typeof runnerOwnershipManifestSchema>;

export interface RunnerTaggedResource {
  id: string;
  type: string;
  tags: Record<string, string>;
}

export interface RunnerObservedInventory {
  accountId: string;
  githubOwner?: string;
  taggedResources: RunnerTaggedResource[];
  worker?: { name: string };
  applications: Array<{ id: string; name: string }>;
  workflows: Array<{ id: string; name: string }>;
  databases: Array<{ id?: string; name: string }>;
  bucket?: { name: string; managedObjects: number; unknownObjects: number };
  images: string[];
}

export interface TeardownOperation {
  kind: string;
  id: string;
  name: string;
  prefixes?: string[];
  unknownObjects?: number;
}

export function newRunnerInstallationId(): string {
  return randomUUID();
}

export function parseRunnerOwnershipManifest(value: string | undefined): RunnerOwnershipManifest | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return runnerOwnershipManifestSchema.safeParse(JSON.parse(value)).data;
  } catch {
    return undefined;
  }
}

export function serializeRunnerOwnershipManifest(manifest: RunnerOwnershipManifest): string {
  return JSON.stringify(runnerOwnershipManifestSchema.parse(manifest));
}

export function runnerOwnershipTags(installationId: string) {
  return {
    "managed-by": runnerOwnershipManagedBy,
    "runner-installation-id": z.uuid().parse(installationId),
  };
}

export function resourceHasRunnerOwnershipTags(
  resource: RunnerTaggedResource | undefined,
  installationId: string,
): boolean {
  const tags = resource?.tags ?? {};
  const expected = runnerOwnershipTags(installationId);
  return (
    tags["managed-by"] === expected["managed-by"] &&
    tags["runner-installation-id"] === expected["runner-installation-id"]
  );
}

function stableSort<Value>(values: Value[], key: (value: Value) => string): Value[] {
  return [...values].sort((left, right) => key(left).localeCompare(key(right)));
}

function tagKey(type: string, id: string): string {
  return `${type}:${id}`;
}

export function buildOwnedTeardownPlan(
  manifestValue: RunnerOwnershipManifest | undefined,
  observed: RunnerObservedInventory,
) {
  if (manifestValue === undefined) {
    return { blocked: ["The Worker does not contain a valid runner ownership manifest"], operations: [] };
  }
  const owned = manifestValue;
  const blocked: string[] = [];
  if (observed.accountId !== owned.accountId) {
    blocked.push(`Ownership manifest belongs to Cloudflare account ${owned.accountId}`);
  }
  if (observed.githubOwner?.toLowerCase() !== owned.githubOwner.toLowerCase()) {
    blocked.push(`Ownership manifest belongs to GitHub owner ${owned.githubOwner}`);
  }
  if (observed.worker !== undefined && observed.worker.name !== owned.worker.name) {
    blocked.push(`Observed Worker does not match owned Worker ${owned.worker.name}`);
  }
  if (observed.bucket !== undefined && observed.bucket.name !== owned.bucket.name) {
    blocked.push(`Observed R2 bucket does not match owned R2 bucket ${owned.bucket.name}`);
  }

  const tags = new Map(observed.taggedResources.map((resource) => [tagKey(resource.type, resource.id), resource]));
  for (const resource of [
    { type: "worker", id: owned.worker.name, label: `Worker ${owned.worker.name}` },
    { type: "d1_database", id: owned.database.id, label: `D1 database ${owned.database.name}` },
    { type: "r2_bucket", id: owned.bucket.name, label: `R2 bucket ${owned.bucket.name}` },
  ]) {
    if (!resourceHasRunnerOwnershipTags(tags.get(tagKey(resource.type, resource.id)), owned.installationId)) {
      blocked.push(`${resource.label} does not have matching installation ownership tags`);
    }
  }

  const applicationsByName = new Map(observed.applications.map((resource) => [resource.name, resource]));
  for (const expected of owned.applications) {
    const actual = applicationsByName.get(expected.name);
    if (actual !== undefined && actual.id !== expected.id) {
      blocked.push(`Container application ${expected.name} changed immutable ID`);
    }
  }
  const databasesByName = new Map(observed.databases.map((resource) => [resource.name, resource]));
  const actualDatabase = databasesByName.get(owned.database.name);
  if (actualDatabase !== undefined && actualDatabase.id !== owned.database.id) {
    blocked.push(`D1 database ${owned.database.name} changed immutable ID`);
  }
  const workflowsByName = new Map(observed.workflows.map((resource) => [resource.name, resource]));
  for (const expected of owned.workflows) {
    const actual = workflowsByName.get(expected.name);
    if (actual !== undefined && actual.id !== expected.id) {
      blocked.push(`Workflow ${expected.name} changed immutable ID`);
    }
  }
  if (blocked.length > 0) {
    return { manifest: owned, blocked, operations: [] };
  }

  const observedImages = new Set(observed.images);
  const unknownR2Objects = observed.bucket?.unknownObjects ?? 0;
  const operations: TeardownOperation[] = [
    ...stableSort(owned.workflows, ({ name }) => name)
      .filter(({ name }) => workflowsByName.has(name))
      .map(({ id, name }) => ({ kind: "workflow", id, name })),
    ...(observed.worker === undefined ? [] : [{ kind: "worker", id: owned.worker.name, name: owned.worker.name }]),
    ...stableSort(owned.applications, ({ name }) => name)
      .filter(({ name }) => applicationsByName.has(name))
      .map(({ id, name }) => ({ kind: "application", id, name })),
    ...stableSort(owned.images, ({ reference }) => reference)
      .filter(({ reference }) => observedImages.has(reference))
      .map(({ reference }) => ({ kind: "image", id: reference, name: reference })),
    ...(observed.bucket === undefined
      ? []
      : [
          {
            kind: unknownR2Objects === 0 ? "bucket" : "bucket-prefixes",
            id: owned.bucket.name,
            name: owned.bucket.name,
            prefixes: owned.bucket.prefixes,
            unknownObjects: unknownR2Objects,
          },
        ]),
    ...(actualDatabase === undefined ? [] : [{ kind: "database", id: owned.database.id, name: owned.database.name }]),
    ...(owned.cloudflareToken === undefined
      ? []
      : [{ kind: "cloudflare-token", id: owned.cloudflareToken.id, name: owned.cloudflareToken.id }]),
    ...(owned.githubApp === undefined
      ? []
      : [{ kind: "github-app", id: String(owned.githubApp.id), name: owned.githubApp.slug }]),
  ];
  return { manifest: owned, blocked: [], operations };
}
