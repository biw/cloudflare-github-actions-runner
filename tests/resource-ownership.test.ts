import { describe, expect, it } from "vite-plus/test";

import {
  buildOwnedTeardownPlan,
  parseRunnerOwnershipManifest,
  runnerOwnershipTags,
  serializeRunnerOwnershipManifest,
  type RunnerObservedInventory,
  type RunnerOwnershipManifest,
} from "../scripts/resource-ownership";

const installationId = "11111111-1111-4111-8111-111111111111";
const accountId = "0123456789abcdef0123456789abcdef";

function ownershipManifest(): RunnerOwnershipManifest {
  return {
    version: 1,
    installationId,
    accountId,
    githubOwner: "ahoylabs",
    worker: { name: "runner-worker" },
    applications: [
      { id: "application-builder-id", name: "runner-builder" },
      { id: "application-runner-id", name: "runner-application" },
    ],
    pendingApplications: [],
    workflows: [
      { id: "workflow-build-id", name: "runner-image-build" },
      { id: "workflow-provisioning-id", name: "runner-provisioning" },
    ],
    pendingWorkflows: [],
    database: { id: "database-id", name: "runner-metrics" },
    bucket: {
      name: "runner-storage",
      prefixes: ["runner-image-source/", "runner-cache/npm/", "runner-cache/actions-cache-v2/"],
    },
    images: [{ reference: "runner-builder:build-1" }, { reference: "runner-image:build-1" }],
    cloudflareToken: { id: "fedcba9876543210fedcba9876543210" },
    githubApp: { id: 123, slug: "runner-app", owner: "ahoylabs" },
  };
}

function ownedTag(type: string, id: string) {
  return { id, type, tags: runnerOwnershipTags(installationId) };
}

function observedInventory(overrides: Partial<RunnerObservedInventory> = {}): RunnerObservedInventory {
  return {
    accountId,
    githubOwner: "ahoylabs",
    taggedResources: [
      ownedTag("worker", "runner-worker"),
      ownedTag("d1_database", "database-id"),
      ownedTag("r2_bucket", "runner-storage"),
    ],
    worker: { name: "runner-worker" },
    applications: [
      { id: "application-builder-id", name: "runner-builder" },
      { id: "application-runner-id", name: "runner-application" },
    ],
    workflows: [
      { id: "workflow-build-id", name: "runner-image-build" },
      { id: "workflow-provisioning-id", name: "runner-provisioning" },
    ],
    databases: [{ id: "database-id", name: "runner-metrics" }],
    bucket: { name: "runner-storage", managedObjects: 10, unknownObjects: 0 },
    images: ["runner-builder:build-1", "runner-image:build-1"],
    ...overrides,
  };
}

describe("runner resource ownership", () => {
  it("round-trips only a valid versioned ownership manifest", () => {
    const manifest = ownershipManifest();
    expect(parseRunnerOwnershipManifest(serializeRunnerOwnershipManifest(manifest))).toEqual(manifest);
    expect(parseRunnerOwnershipManifest("not JSON")).toBeUndefined();
    expect(parseRunnerOwnershipManifest(JSON.stringify({ ...manifest, installationId: "not-a-uuid" }))).toBeUndefined();
  });

  it("produces no operations without a valid ownership manifest", () => {
    expect(buildOwnedTeardownPlan(undefined, observedInventory())).toEqual({
      blocked: ["The Worker does not contain a valid runner ownership manifest"],
      operations: [],
    });
  });

  it("produces no operations for the wrong Cloudflare account or GitHub owner", () => {
    const result = buildOwnedTeardownPlan(
      ownershipManifest(),
      observedInventory({ accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", githubOwner: "someone-else" }),
    );

    expect(result.operations).toEqual([]);
    expect(result.blocked).toEqual([
      `Ownership manifest belongs to Cloudflare account ${accountId}`,
      "Ownership manifest belongs to GitHub owner ahoylabs",
    ]);
  });

  it("treats names without matching installation tags as unowned", () => {
    const result = buildOwnedTeardownPlan(
      ownershipManifest(),
      observedInventory({
        taggedResources: [
          ownedTag("worker", "runner-worker"),
          ownedTag("d1_database", "database-id"),
          {
            id: "runner-storage",
            type: "r2_bucket",
            tags: { "managed-by": "another-tool", "runner-installation-id": installationId },
          },
        ],
      }),
    );

    expect(result.operations).toEqual([]);
    expect(result.blocked).toEqual(["R2 bucket runner-storage does not have matching installation ownership tags"]);
  });

  it("blocks the complete plan when any immutable resource ID drifts", () => {
    const result = buildOwnedTeardownPlan(
      ownershipManifest(),
      observedInventory({
        applications: [{ id: "replacement-id", name: "runner-application" }],
        workflows: [{ id: "replacement-workflow-id", name: "runner-image-build" }],
        databases: [{ id: "replacement-database-id", name: "runner-metrics" }],
      }),
    );

    expect(result.operations).toEqual([]);
    expect(result.blocked).toEqual([
      "Container application runner-application changed immutable ID",
      "D1 database runner-metrics changed immutable ID",
      "Workflow runner-image-build changed immutable ID",
    ]);
  });

  it("blocks a manifest that points away from the observed Worker or bucket", () => {
    const result = buildOwnedTeardownPlan(
      ownershipManifest(),
      observedInventory({
        worker: { name: "another-worker" },
        bucket: { name: "customer-storage", managedObjects: 0, unknownObjects: 0 },
      }),
    );

    expect(result.operations).toEqual([]);
    expect(result.blocked).toEqual([
      "Observed Worker does not match owned Worker runner-worker",
      "Observed R2 bucket does not match owned R2 bucket runner-storage",
    ]);
  });

  it("plans only manifest-recorded resources and ignores same-account extras", () => {
    const result = buildOwnedTeardownPlan(
      ownershipManifest(),
      observedInventory({
        applications: [
          ...observedInventory().applications,
          { id: "customer-application-id", name: "customer-application" },
        ],
        workflows: [...observedInventory().workflows, { id: "customer-workflow-id", name: "customer-workflow" }],
        databases: [...observedInventory().databases, { id: "customer-database-id", name: "customer-database" }],
        images: [...observedInventory().images, "customer-image:current"],
      }),
    );

    expect(result.blocked).toEqual([]);
    expect(result.operations.map(({ kind, id }) => ({ kind, id }))).toEqual([
      { kind: "workflow", id: "workflow-build-id" },
      { kind: "workflow", id: "workflow-provisioning-id" },
      { kind: "worker", id: "runner-worker" },
      { kind: "application", id: "application-runner-id" },
      { kind: "application", id: "application-builder-id" },
      { kind: "image", id: "runner-builder:build-1" },
      { kind: "image", id: "runner-image:build-1" },
      { kind: "bucket", id: "runner-storage" },
      { kind: "database", id: "database-id" },
      { kind: "cloudflare-token", id: "fedcba9876543210fedcba9876543210" },
      { kind: "github-app", id: "123" },
    ]);
  });

  it("keeps a mixed-use R2 bucket and deletes only recorded prefixes", () => {
    const result = buildOwnedTeardownPlan(
      ownershipManifest(),
      observedInventory({ bucket: { name: "runner-storage", managedObjects: 10, unknownObjects: 3 } }),
    );
    const bucketOperation = result.operations.find(({ kind }) => kind === "bucket-prefixes");

    expect(result.blocked).toEqual([]);
    expect(bucketOperation).toEqual({
      kind: "bucket-prefixes",
      id: "runner-storage",
      name: "runner-storage",
      prefixes: ownershipManifest().bucket.prefixes,
      unknownObjects: 3,
    });
    expect(result.operations.some(({ kind }) => kind === "bucket")).toBe(false);
  });
});
