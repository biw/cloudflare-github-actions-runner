import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  activeInstanceCount,
  cloudflareAuthenticationToken,
  CommandExecutionError,
  configureRunnerStorageBindings,
  deploymentProgressPrefix,
  defaultRunnerCacheMaxBytes,
  ownershipManifestResourceCollisions,
  parseJsonc,
  preserveCustomApplicationConfiguration,
  preserveRunnerApplicationImages,
  r2BucketIsPublic,
  r2LifecycleRuleExists,
  resourceMetricsDatabaseFromList,
  r2BucketExistsInList,
  retryTransientWranglerAuthentication,
  runnerCacheBytesFromGigabytes,
  runnerCacheConfigurationFromEnvironment,
  runnerCacheConfigurationFromWorkerSettings,
  runnerImageBuilderBootstrapConfiguration,
  runnerPoolGitHubOwnerFromWorkerSettings,
  runnerStorageLifecycleRules,
  transientWranglerAuthenticationError,
  unmanagedSetupCollisions,
  validRunnerCacheBucketName,
  wranglerAuthenticationToken,
} from "../scripts/deploy.ts";

const customApplication = "cloudflare-github-actions-runner-custom";

function configuration() {
  return {
    image: "registry.cloudflare.com/account/runner@sha256:abc",
    vcpu: 4,
    memory_mib: 12_288,
    disk: { size_mb: 4_000 },
  };
}

function config() {
  return {
    vars: { CUSTOM_RUNNER_APPLICATION: customApplication },
    containers: [
      {
        name: customApplication,
        image: "registry.cloudflare.com/account/runner@sha256:abc",
        instance_type: { vcpu: 1, memory_mib: 3_072, disk_mb: 6_000 },
        max_instances: 1,
      },
    ],
  };
}

describe("account-safe deployment", () => {
  it("always starts the builder from a controlled public image and requires an in-Worker manifest verification", () => {
    const builder = runnerImageBuilderBootstrapConfiguration(
      { vars: { RUNNER_IMAGE_BUILDER_IMAGE_NAME: "runner-image-builder" } },
      { CLOUDFLARE_ACCOUNT_ID: "account-id" },
    );

    expect(builder).toMatchObject({
      reference: "registry.cloudflare.com/account-id/runner-image-builder:kaniko-v1",
      image: "docker.io/library/ubuntu:24.04",
    });
    expect(builder.deploymentId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("uses a machine-readable prefix for setup deployment progress", () => {
    expect(deploymentProgressPrefix).toBe("CLOUDFLARE_RUNNER_SETUP_PHASE:");
  });

  it("reserves enough Workflow steps for three queued remote image-build rounds", async () => {
    const configText = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    const parsedConfig = z
      .object({
        workflows: z.array(z.object({ binding: z.string(), limits: z.object({ steps: z.number() }).optional() })),
      })
      .parse(parseJsonc(configText));
    const workflow = parsedConfig.workflows.find((candidate) => candidate.binding === "RUNNER_IMAGE_BUILD_WORKFLOW");
    expect(workflow?.limits?.steps).toBe(10_000);
  });

  it("configures both runner R2 bindings to one storage bucket", async () => {
    const configText = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    const parsedConfig = z
      .object({
        r2_buckets: z.array(z.object({ binding: z.string(), bucket_name: z.string() })),
      })
      .parse(parseJsonc(configText));
    const runnerBuckets = parsedConfig.r2_buckets.filter(({ binding }) =>
      ["RUNNER_CACHE", "RUNNER_IMAGE_SOURCE"].includes(binding),
    );

    expect(runnerBuckets.map(({ binding }) => binding).sort()).toEqual(["RUNNER_CACHE", "RUNNER_IMAGE_SOURCE"]);
    expect(new Set(runnerBuckets.map(({ bucket_name: bucketName }) => bucketName))).toEqual(
      new Set(["cloudflare-github-actions-runner-cache"]),
    );
  });

  it("refuses every pre-existing exact-name resource until it is explicitly adopted", () => {
    expect(
      unmanagedSetupCollisions(
        {
          name: "runner-worker",
          containers: [{ name: "runner-application" }],
          workflows: [{ name: "runner-workflow" }],
          vars: { RUNNER_IMAGE_NAME: "runner-image", RUNNER_IMAGE_BUILDER_IMAGE_NAME: "runner-builder" },
        },
        {
          workerExists: true,
          database: { id: "database-id", name: "runner-metrics" },
          bucketExists: true,
          bucketName: "runner-storage",
          applications: [{ id: "application-id", name: "runner-application" }],
          workflows: [{ name: "runner-workflow" }],
          images: [
            { name: "runner-image", tags: ["current"] },
            { name: "runner-builder", tags: ["current"] },
          ],
        },
      ),
    ).toEqual([
      "Worker runner-worker",
      "D1 database runner-metrics",
      "R2 bucket runner-storage",
      "Container application runner-application",
      "Workflow runner-workflow",
      "registry image runner-image",
      "registry image runner-builder",
    ]);
  });

  it("ignores unrelated resources during setup collision detection", () => {
    expect(
      unmanagedSetupCollisions(
        {
          name: "runner-worker",
          containers: [{ name: "runner-application" }],
          workflows: [{ name: "runner-workflow" }],
          vars: { RUNNER_IMAGE_NAME: "runner-image", RUNNER_IMAGE_BUILDER_IMAGE_NAME: "runner-builder" },
        },
        {
          workerExists: false,
          database: undefined,
          bucketExists: false,
          bucketName: "runner-storage",
          applications: [{ id: "application-id", name: "customer-application" }],
          workflows: [{ name: "customer-workflow" }],
          images: [{ name: "customer-image", tags: ["current"] }],
        },
      ),
    ).toEqual([]);
  });

  it("accepts only immutable IDs or prior creation intents on a managed rerun", () => {
    const deploymentConfig = {
      containers: [{ name: "runner-application" }, { name: "runner-new-application" }],
      workflows: [{ name: "runner-workflow" }, { name: "runner-new-workflow" }],
    };
    const manifest = {
      applications: [{ id: "owned-application-id", name: "runner-application" }],
      pendingApplications: [{ name: "runner-new-application" }],
      workflows: [{ id: "owned-workflow-id", name: "runner-workflow" }],
      pendingWorkflows: [{ name: "runner-new-workflow" }],
    };

    expect(
      ownershipManifestResourceCollisions(deploymentConfig, manifest, {
        applications: [
          { id: "owned-application-id", name: "runner-application" },
          { id: "created-application-id", name: "runner-new-application" },
        ],
        workflows: [
          { id: "owned-workflow-id", name: "runner-workflow" },
          { id: "created-workflow-id", name: "runner-new-workflow" },
        ],
      }),
    ).toEqual([]);

    expect(
      ownershipManifestResourceCollisions(deploymentConfig, manifest, {
        applications: [{ id: "replacement-id", name: "runner-application" }],
        workflows: [{ id: "replacement-id", name: "runner-workflow" }],
      }),
    ).toEqual([
      "Container application runner-application is not owned by the existing installation manifest",
      "Workflow runner-workflow is not owned by the existing installation manifest",
    ]);
  });

  it("parses the repository's JSONC configuration", () => {
    expect(parseJsonc('{ // comment\n "name": "runner",\n}')).toEqual({ name: "runner" });
  });

  it("reuses the account's resource-metrics D1 database by name", () => {
    expect(
      resourceMetricsDatabaseFromList([
        { name: "other", uuid: "00000000-0000-0000-0000-000000000000" },
        { name: "cloudflare-github-actions-runner-metrics", uuid: "11111111-1111-1111-1111-111111111111" },
      ]),
    ).toEqual({ name: "cloudflare-github-actions-runner-metrics", id: "11111111-1111-1111-1111-111111111111" });
  });

  it("recognizes an existing account-owned R2 cache bucket from Wrangler output", () => {
    expect(
      r2BucketExistsInList(`name:           another-bucket

name:           cloudflare-github-actions-runner-cache
creation_date:  2026-08-13T00:00:00.000Z`),
    ).toBe(true);
    expect(r2BucketExistsInList("name:           another-bucket")).toBe(false);
    expect(
      r2LifecycleRuleExists(
        "name:     Default Multipart Abort Rule\nname:     runner-cache-proxy-expiry",
        "runner-cache-proxy-expiry",
      ),
    ).toBe(true);
    expect(r2LifecycleRuleExists("name:     Default Multipart Abort Rule", "runner-cache-proxy-expiry")).toBe(false);
  });

  it("validates the optional private R2 cache settings", () => {
    expect(validRunnerCacheBucketName("cloudflare-github-actions-runner-cache")).toBe(true);
    expect(validRunnerCacheBucketName("Cache Bucket")).toBe(false);
    expect(runnerCacheBytesFromGigabytes("100")).toBe(defaultRunnerCacheMaxBytes);
    expect(runnerCacheBytesFromGigabytes("0")).toBeUndefined();
    expect(
      runnerCacheConfigurationFromEnvironment({
        RUNNER_CACHE_ENABLED: "true",
        RUNNER_CACHE_BUCKET_NAME: "team-ci-cache",
        RUNNER_CACHE_MAX_SIZE_GB: "250",
      }),
    ).toMatchObject({ enabled: true, bucketName: "team-ci-cache", maxBytes: 250_000_000_000 });
    expect(runnerCacheConfigurationFromEnvironment({ RUNNER_CACHE_ENABLED: "false" })).toMatchObject({
      enabled: false,
    });
  });

  it("preserves cache configuration from the deployed Worker and detects public buckets", () => {
    expect(
      runnerCacheConfigurationFromWorkerSettings({
        bindings: [
          { name: "RUNNER_CACHE", bucket_name: "team-ci-cache" },
          { name: "RUNNER_CACHE_ENABLED", text: "true" },
          { name: "RUNNER_CACHE_MAX_BYTES", text: "250000000000" },
          { name: "RUNNER_CACHE_PREFIX", text: "cloudflare-github-actions-runner" },
        ],
      }),
    ).toMatchObject({ enabled: true, bucketName: "team-ci-cache", maxBytes: 250_000_000_000 });
    expect(
      runnerCacheConfigurationFromWorkerSettings({
        bindings: [
          { name: "RUNNER_IMAGE_SOURCE", bucket_name: "team-runner-storage" },
          { name: "RUNNER_CACHE_ENABLED", text: "false" },
        ],
      }),
    ).toMatchObject({ enabled: false, bucketName: "team-runner-storage" });
    expect(r2BucketIsPublic({ enabled: false }, { domains: [{ enabled: false }] })).toBe(false);
    expect(r2BucketIsPublic({ enabled: true }, { domains: [] })).toBe(true);
    expect(r2BucketIsPublic({ enabled: false }, { domains: [{ enabled: true }] })).toBe(true);
    expect(
      runnerPoolGitHubOwnerFromWorkerSettings({
        bindings: [
          { name: "GITHUB_RUNNER_OWNER", text: "legacy-owner" },
          { name: "RUNNER_POOL_GITHUB_OWNER", text: "ahoylabs" },
        ],
      }),
    ).toBe("ahoylabs");
  });

  it("uses one private R2 bucket with prefix-specific lifecycle rules", () => {
    const deploymentConfig = {
      r2_buckets: [
        { binding: "RUNNER_CACHE", bucket_name: "old-cache" },
        { binding: "RUNNER_IMAGE_SOURCE", bucket_name: "old-source" },
      ],
    };
    const cacheConfiguration = {
      enabled: true,
      bucketName: "team-runner-storage",
      prefix: "cloudflare-github-actions-runner",
    };

    configureRunnerStorageBindings(deploymentConfig, cacheConfiguration);

    expect(new Set(deploymentConfig.r2_buckets.map(({ bucket_name: bucketName }) => bucketName))).toEqual(
      new Set(["team-runner-storage"]),
    );
    expect(runnerStorageLifecycleRules(cacheConfiguration)).toEqual([
      { name: "runner-image-source-expiry", prefix: "runner-image-source/", expireDays: 1 },
      {
        name: "runner-cache-proxy-expiry",
        prefix: "cloudflare-github-actions-runner/npm/",
        expireDays: 30,
      },
      {
        name: "actions-cache-v2-expiry",
        prefix: "cloudflare-github-actions-runner/actions-cache-v2/",
        expireDays: 30,
      },
    ]);

    configureRunnerStorageBindings(deploymentConfig, { ...cacheConfiguration, enabled: false });
    expect(deploymentConfig.r2_buckets).toEqual([
      { binding: "RUNNER_IMAGE_SOURCE", bucket_name: "team-runner-storage" },
    ]);
  });

  it("extracts a Wrangler token without retaining any CLI decoration", () => {
    expect(wranglerAuthenticationToken('{"token":"abc.def-123"}')).toBe("abc.def-123");
    expect(wranglerAuthenticationToken('\n⛅️ Wrangler\n{"token":"abc.def-123"}\n')).toBe("abc.def-123");
  });

  it("uses the setup-provided Cloudflare token without refreshing Wrangler OAuth", async () => {
    await expect(cloudflareAuthenticationToken({ CLOUDFLARE_API_TOKEN: "setup-token" })).resolves.toBe("setup-token");
  });

  it("retries Wrangler's transient account authorization response", async () => {
    let attempts = 0;
    const result = await retryTransientWranglerAuthentication(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new CommandExecutionError(
            "wrangler exited with status 1",
            "The given account is not valid or is not authorized to access this service [code: 7403]",
          );
        }
        return "authorized";
      },
      { attempts: 3, retryDelayMs: 0 },
    );

    expect(result).toBe("authorized");
    expect(attempts).toBe(3);
  });

  it("does not classify unrelated Wrangler failures as transient authentication", () => {
    const error = new CommandExecutionError("wrangler exited with status 1", "Cloudflare API failed [code: 10000]");

    expect(transientWranglerAuthenticationError(error)).toBe(false);
  });

  it("uses the live custom shape and ceiling during deployment", () => {
    const deploymentConfig = config();
    preserveCustomApplicationConfiguration(
      deploymentConfig,
      new Map([
        [
          customApplication,
          {
            configuration: configuration(),
            max_instances: 2,
            health: { instances: { active: 0, assigned: 0, starting: 0, scheduling: 0 } },
          },
        ],
      ]),
    );

    expect(deploymentConfig.containers[0]).toMatchObject({
      instance_type: { vcpu: 4, memory_mib: 12_288, disk_mb: 4_000 },
      max_instances: 2,
    });
  });

  it("preserves an idle preset ceiling during an ordinary source deployment", () => {
    const deploymentConfig = {
      vars: { CUSTOM_RUNNER_APPLICATION: customApplication },
      containers: [{ name: "runner-standard-3", instance_type: "standard-3", max_instances: 1 }],
    };
    preserveCustomApplicationConfiguration(
      deploymentConfig,
      new Map([
        [
          "runner-standard-3",
          {
            max_instances: 5,
            health: { instances: { active: 0, assigned: 0, starting: 0, scheduling: 0 } },
          },
        ],
      ]),
    );

    expect(deploymentConfig.containers[0]).toMatchObject({ max_instances: 5 });
  });

  it("updates the pinned builder image while preserving remote runner images", () => {
    const deploymentConfig = {
      vars: { RUNNER_IMAGE_BUILDER_APPLICATION: "runner-image-builder" },
      containers: [
        { name: "runner-image-builder", image: "docker.io/library/docker@sha256:new" },
        { name: "runner-standard-3", image: "docker.io/library/ubuntu:24.04" },
      ],
    };
    preserveRunnerApplicationImages(
      deploymentConfig,
      new Map([
        ["runner-image-builder", { configuration: { image: "docker.io/library/docker@sha256:old" } }],
        ["runner-standard-3", { configuration: { image: "registry.cloudflare.com/account/runner:immutable" } }],
      ]),
    );

    expect(deploymentConfig.containers).toEqual([
      { name: "runner-image-builder", image: "docker.io/library/docker@sha256:new" },
      { name: "runner-standard-3", image: "registry.cloudflare.com/account/runner:immutable" },
    ]);
  });

  it("keeps a live custom application's current image while other applications can deploy", () => {
    const deploymentConfig = config();
    deploymentConfig.containers[0].image = "registry.cloudflare.com/account/runner:new";
    preserveCustomApplicationConfiguration(
      deploymentConfig,
      new Map([
        [
          customApplication,
          {
            configuration: configuration(),
            max_instances: 2,
            health: { instances: { active: 1 } },
          },
        ],
      ]),
    );
    expect(deploymentConfig.containers[0]).toMatchObject({
      image: "registry.cloudflare.com/account/runner@sha256:abc",
      instance_type: { vcpu: 4, memory_mib: 12_288, disk_mb: 4_000 },
      max_instances: 2,
    });
    expect(activeInstanceCount({ health: { instances: { active: 1, assigned: 2 } } })).toBe(3);
  });

  it("preserves a live custom application's existing configuration when its image is unchanged", () => {
    expect(() =>
      preserveCustomApplicationConfiguration(
        config(),
        new Map([
          [
            customApplication,
            {
              configuration: configuration(),
              max_instances: 2,
              health: { instances: { starting: 1 } },
            },
          ],
        ]),
      ),
    ).not.toThrow();
  });
});
