import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  CloudflareContainersApiError,
  configureCustomMachine,
  createContainerRegistryPushCredentials,
  getCustomMachineRolloutStatus,
  prepareRunnerApplication,
  reconcileRunnerApplicationCapacity,
  rolloutRunnerApplicationImages,
  rolloutRunnerImageBuilderApplication,
  runnerImageBuilderApplicationHasLiveInstances,
  runnerImageBuilderApplicationRolloutsAreActive,
  type ContainersApiDependencies,
  updateCustomMachineMaxInstances,
} from "../src/cloudflare-containers";

const env = {
  CLOUDFLARE_ACCOUNT_ID: "account-id",
  CLOUDFLARE_CONTAINERS_API_TOKEN: "cloudflare-token",
  CUSTOM_RUNNER_APPLICATION: "runner-custom",
  RUNNER_APPLICATION_PREFIX: "runner",
  RUNNER_IMAGE_BUILDER_APPLICATION: "runner-image-builder",
};

const resources = { vcpu: 2, memoryMib: 6_144, diskMb: 12_000 };

function configuration(values = resources) {
  return {
    image: "registry.cloudflare.com/runner-image:deployment-id",
    vcpu: values.vcpu,
    memory_mib: values.memoryMib,
    disk: { size_mb: values.diskMb },
  };
}

function application(values = resources, name = env.CUSTOM_RUNNER_APPLICATION) {
  return {
    id: "application-id",
    name,
    max_instances: 1,
    scheduling_policy: "regional",
    rollout_active_grace_period: 300,
    configuration: configuration(values),
  };
}

function rollout(status = "progressing", values = resources) {
  return {
    id: "rollout-id",
    status,
    target_configuration: configuration(values),
  };
}

function response(result: z.core.util.JSONType, init?: ResponseInit): Response {
  return Response.json({ success: true, result, errors: [] }, init);
}

function dependencies(...responses: Response[]): ContainersApiDependencies & { fetch: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn<ContainersApiDependencies["fetch"]>(async () => {
    const next = responses.shift();
    if (next === undefined) {
      throw new Error("Unexpected Containers API request");
    }
    return next;
  });
  return { fetch: fetchMock };
}

describe("Cloudflare custom Container configuration", () => {
  it("reads a full page of rollout history before deciding an image needs another rollout", async () => {
    const deps = dependencies(response([application()]), response([]));

    await configureCustomMachine(env, resources, deps);

    expect(String(deps.fetch.mock.calls[1]?.[0])).toContain("/rollouts?limit=100");
  });

  it("detects a deployment rollout on the temporary daemonless builder", async () => {
    const builder = application(resources, "runner-image-builder");
    const active = dependencies(response([builder]), response([rollout("progressing")]));
    const complete = dependencies(response([builder]), response([rollout("completed")]));

    await expect(runnerImageBuilderApplicationRolloutsAreActive(env, active)).resolves.toBe(true);
    await expect(runnerImageBuilderApplicationRolloutsAreActive(env, complete)).resolves.toBe(false);
  });

  it("detects whether the temporary daemonless builder still has a live instance", async () => {
    const busy = dependencies(
      response([{ ...application(resources, "runner-image-builder"), health: { instances: { active: 1 } } }]),
    );
    const idle = dependencies(
      response([{ ...application(resources, "runner-image-builder"), health: { instances: { active: 0 } } }]),
    );

    await expect(runnerImageBuilderApplicationHasLiveInstances(env, busy)).resolves.toBe(true);
    await expect(runnerImageBuilderApplicationHasLiveInstances(env, idle)).resolves.toBe(false);
  });

  it("does not treat an assigned slot for a stopped builder Container as live", async () => {
    const stopped = dependencies(
      response([
        {
          ...application(resources, "runner-image-builder"),
          health: {
            instances: {
              active: 0,
              assigned: 1,
              failed: 0,
              healthy: 0,
              scheduling: 0,
              starting: 0,
              stopped: 0,
            },
          },
        },
      ]),
    );

    await expect(runnerImageBuilderApplicationHasLiveInstances(env, stopped)).resolves.toBe(false);
  });

  it("uses an application whose current machine configuration already matches", async () => {
    const deps = dependencies(response([application()]), response([]));

    await expect(configureCustomMachine(env, resources, deps)).resolves.toEqual({
      kind: "ready",
      applicationId: "application-id",
    });
    expect(deps.fetch).toHaveBeenCalledTimes(2);
  });

  it("reuses an active rollout that targets the requested machine", async () => {
    const deps = dependencies(
      response([application({ vcpu: 1, memoryMib: 3_072, diskMb: 6_000 })]),
      response([rollout()]),
    );

    await expect(configureCustomMachine(env, resources, deps)).resolves.toEqual({
      kind: "rollout",
      applicationId: "application-id",
      rolloutId: "rollout-id",
    });
    expect(deps.fetch).toHaveBeenCalledTimes(2);
  });

  it("waits before replacing an active rollout for a different machine", async () => {
    const otherResources = { vcpu: 1, memoryMib: 3_072, diskMb: 6_000 };
    const deps = dependencies(
      response([application(otherResources)]),
      response([rollout("progressing", otherResources)]),
    );

    await expect(configureCustomMachine(env, resources, deps)).rejects.toEqual(
      expect.objectContaining<Partial<CloudflareContainersApiError>>({
        status: 409,
        message: "Another Container configuration is still rolling out; retry after it completes",
      }),
    );
    expect(deps.fetch).toHaveBeenCalledTimes(2);
  });

  it("updates the application and creates a rollout for a new machine", async () => {
    const initialResources = { vcpu: 1, memoryMib: 3_072, diskMb: 6_000 };
    const deps = dependencies(
      response([application(initialResources)]),
      response([]),
      response(application(resources)),
      response(rollout()),
    );

    await expect(configureCustomMachine(env, resources, deps)).resolves.toEqual({
      kind: "rollout",
      applicationId: "application-id",
      rolloutId: "rollout-id",
    });

    const patchRequest = deps.fetch.mock.calls[2];
    expect(patchRequest?.[0]).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-id/containers/applications/application-id",
    );
    expect(patchRequest?.[1]).toMatchObject({ method: "PATCH" });
    expect(JSON.parse(String(patchRequest?.[1]?.body))).toEqual({
      configuration: configuration(),
      max_instances: 1,
      scheduling_policy: "regional",
      rollout_active_grace_period: 300,
    });

    const rolloutRequest = deps.fetch.mock.calls[3];
    expect(rolloutRequest?.[0]).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-id/containers/applications/application-id/rollouts",
    );
    expect(rolloutRequest?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(rolloutRequest?.[1]?.body))).toMatchObject({
      strategy: "rolling",
      target_configuration: configuration(),
      step_percentage: 100,
      kind: "full_auto",
    });
  });

  it("updates only the custom application's maximum instance count", async () => {
    const deps = dependencies(response([application()]), response(application()));

    await expect(updateCustomMachineMaxInstances(env, 2, deps)).resolves.toEqual({
      applicationId: "application-id",
      previousMaxInstances: 1,
      maxInstances: 2,
    });

    const patchRequest = deps.fetch.mock.calls[1];
    expect(patchRequest?.[0]).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-id/containers/applications/application-id",
    );
    expect(patchRequest?.[1]).toMatchObject({ method: "PATCH" });
    expect(JSON.parse(String(patchRequest?.[1]?.body))).toEqual({
      configuration: configuration(),
      max_instances: 2,
      scheduling_policy: "regional",
      rollout_active_grace_period: 300,
    });
  });

  it("raises a named runner application's ceiling without a configuration rollout", async () => {
    const applicationName = "runner-standard-3";
    const deps = dependencies(
      response([application(resources, applicationName)]),
      response(application(resources, applicationName)),
    );

    await expect(prepareRunnerApplication(env, applicationName, undefined, 2, deps)).resolves.toEqual({
      kind: "ready",
      applicationId: "application-id",
    });

    const patchRequest = deps.fetch.mock.calls[1];
    expect(patchRequest?.[1]).toMatchObject({ method: "PATCH" });
    expect(JSON.parse(String(patchRequest?.[1]?.body))).toMatchObject({
      max_instances: 2,
      configuration: configuration(),
    });
  });

  it("does not echo read-only configuration metadata into a capacity update", async () => {
    const applicationName = "runner-standard-3";
    const applicationWithReadOnlyMetadata = {
      ...application(resources, applicationName),
      configuration: { ...configuration(), location: "sjc", deployment_type: "regional" },
    };
    const deps = dependencies(response([applicationWithReadOnlyMetadata]), response(applicationWithReadOnlyMetadata));

    await prepareRunnerApplication(env, applicationName, undefined, 2, deps);

    const request = z
      .object({
        configuration: z.object({
          image: z.string(),
          vcpu: z.number(),
          memory_mib: z.number(),
          disk: z.object({ size_mb: z.number() }),
        }),
      })
      .parse(JSON.parse(String(deps.fetch.mock.calls[1]?.[1]?.body)));
    expect(request.configuration).not.toHaveProperty("location");
    expect(request.configuration).not.toHaveProperty("deployment_type");
    expect(request.configuration).toEqual(configuration());
  });

  it("uses the scheduler's exact ceiling while reconfiguring an idle custom slot", async () => {
    const applicationName = "runner-custom";
    const retainedApplication = { ...application(resources, applicationName), max_instances: 10 };
    const deps = dependencies(response([retainedApplication]), response([]), response(retainedApplication));

    await expect(
      prepareRunnerApplication(env, applicationName, resources, 1, deps, { exactMaxInstances: true }),
    ).resolves.toEqual({ kind: "ready", applicationId: "application-id" });

    expect(JSON.parse(String(deps.fetch.mock.calls[2]?.[1]?.body))).toMatchObject({ max_instances: 1 });
  });

  it("reduces a named runner application's ceiling after capacity is released", async () => {
    const applicationName = "runner-standard-3";
    const activeApplication = { ...application(resources, applicationName), max_instances: 2 };
    const deps = dependencies(response([activeApplication]), response(activeApplication));

    await expect(reconcileRunnerApplicationCapacity(env, applicationName, 1, deps)).resolves.toEqual({
      applicationId: "application-id",
      previousMaxInstances: 2,
      maxInstances: 1,
    });

    expect(JSON.parse(String(deps.fetch.mock.calls[1]?.[1]?.body))).toMatchObject({ max_instances: 1 });
  });

  it("returns rollout status and reports Cloudflare API failures", async () => {
    const statusDependencies = dependencies(response(rollout("completed")));
    await expect(getCustomMachineRolloutStatus(env, "application-id", "rollout-id", statusDependencies)).resolves.toBe(
      "completed",
    );

    const failureDependencies = dependencies(
      Response.json(
        { success: false, result: null, errors: [{ message: "Containers Write is required" }] },
        { status: 403 },
      ),
    );
    await expect(configureCustomMachine(env, resources, failureDependencies)).rejects.toEqual(
      expect.objectContaining<Partial<CloudflareContainersApiError>>({
        name: "CloudflareContainersApiError",
        status: 403,
        message: "Cloudflare Containers API 403: Containers Write is required",
      }),
    );
  });

  it("creates a short-lived pull/push registry credential without returning the account token", async () => {
    const deps = dependencies(response({ username: "v1", password: "short-lived-password" }));

    await expect(createContainerRegistryPushCredentials(env, deps)).resolves.toEqual({
      username: "v1",
      password: "short-lived-password",
    });
    expect(deps.fetch).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/account-id/containers/registries/registry.cloudflare.com/credentials",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(String(deps.fetch.mock.calls[0]?.[1]?.body))).toEqual({
      expiration_minutes: 15,
      permissions: ["pull", "push"],
    });
  });

  it("rolls an idle runner image without changing the scheduler-owned capacity ceiling", async () => {
    const idle = {
      ...application(resources, "runner-standard-3"),
      max_instances: 7,
      health: { instances: { active: 0, assigned: 0, starting: 0, scheduling: 0 } },
    };
    const deps = dependencies(
      response([idle]),
      response([idle]),
      response([]),
      response(idle),
      // Cloudflare keeps returning the active image until a rollout applies
      // the accepted PATCH.
      response([idle]),
      response(rollout("completed", resources)),
    );

    await expect(
      rolloutRunnerApplicationImages(env, "registry.cloudflare.com/account/runner:new", deps),
    ).resolves.toEqual({
      updatedApplications: ["runner-standard-3"],
      skippedApplications: [],
    });
    expect(JSON.parse(String(deps.fetch.mock.calls[3]?.[1]?.body))).toEqual({
      configuration: {
        image: "registry.cloudflare.com/account/runner:new",
        vcpu: 2,
        memory_mib: 6_144,
        disk: { size_mb: 12_000 },
      },
    });
    expect(JSON.parse(String(deps.fetch.mock.calls[5]?.[1]?.body))).toMatchObject({
      target_configuration: { image: "registry.cloudflare.com/account/runner:new" },
    });
  });

  it("uses the current custom-machine resources rather than the stale application list during an image rollout", async () => {
    const applicationName = "runner-custom";
    const listed = {
      ...application(resources, applicationName),
      health: { instances: { active: 0, assigned: 0, starting: 0, scheduling: 0 } },
    };
    const refreshedResources = { vcpu: 4, memoryMib: 12_288, diskMb: 20_000 };
    const refreshed = {
      ...application(refreshedResources, applicationName),
      max_instances: 3,
      health: { instances: { active: 0, assigned: 0, starting: 0, scheduling: 0 } },
    };
    const deps = dependencies(
      response([listed]),
      response([refreshed]),
      response([]),
      response(refreshed),
      response([
        {
          ...refreshed,
          configuration: {
            ...refreshed.configuration,
            image: "registry.cloudflare.com/account/runner:new",
            vcpu: 1,
            memory_mib: 6_144,
            disk: { size_mb: 12_000 },
          },
        },
      ]),
      response(rollout("completed", refreshedResources)),
    );

    await rolloutRunnerApplicationImages(env, "registry.cloudflare.com/account/runner:new", deps);

    expect(JSON.parse(String(deps.fetch.mock.calls[3]?.[1]?.body))).toEqual({
      configuration: {
        image: "registry.cloudflare.com/account/runner:new",
        vcpu: 4,
        memory_mib: 12_288,
        disk: { size_mb: 20_000 },
      },
    });
    expect(JSON.parse(String(deps.fetch.mock.calls[5]?.[1]?.body))).toMatchObject({
      target_configuration: {
        image: "registry.cloudflare.com/account/runner:new",
        vcpu: 1,
        memory_mib: 6_144,
        disk: { size_mb: 12_000 },
      },
    });
  });

  it("defers an image rollout while a runner or another rollout is active", async () => {
    const busy = {
      ...application(resources, "runner-standard-3"),
      health: { instances: { active: 1 } },
    };
    const deps = dependencies(response([busy]), response([busy]), response([]));

    await expect(
      rolloutRunnerApplicationImages(env, "registry.cloudflare.com/account/runner:new", deps),
    ).resolves.toEqual({
      updatedApplications: [],
      skippedApplications: ["runner-standard-3"],
    });
    expect(deps.fetch).toHaveBeenCalledTimes(3);
  });

  it("creates a missing rollout after a prior image PATCH reached Cloudflare", async () => {
    const targetImage = "registry.cloudflare.com/account/runner:new";
    const alreadyPatched = {
      ...application(resources, "runner-standard-3"),
      configuration: { ...configuration(), image: targetImage },
      health: { instances: { active: 0 } },
    };
    const deps = dependencies(
      response([alreadyPatched]),
      response([alreadyPatched]),
      response([]),
      response([alreadyPatched]),
      response({ ...rollout("completed"), target_configuration: { ...configuration(), image: targetImage } }),
    );

    await expect(rolloutRunnerApplicationImages(env, targetImage, deps)).resolves.toEqual({
      updatedApplications: ["runner-standard-3"],
      skippedApplications: [],
    });
    expect(deps.fetch).toHaveBeenCalledTimes(5);
    expect(deps.fetch.mock.calls[4]?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(deps.fetch.mock.calls[4]?.[1]?.body))).toMatchObject({
      target_configuration: { image: targetImage },
    });
  });

  it("reissues an interrupted A-to-B-to-A image transition despite an older matching rollout", async () => {
    const targetImage = "registry.cloudflare.com/account/runner:a";
    const previousImage = "registry.cloudflare.com/account/runner:b";
    const repatched = {
      ...application(resources, "runner-standard-3"),
      configuration: { ...configuration(), image: targetImage },
      health: { instances: { active: 0 } },
    };
    const deps = dependencies(
      response([repatched]),
      response([repatched]),
      response([
        { ...rollout("completed"), target_configuration: { ...configuration(), image: previousImage } },
        { ...rollout("completed"), target_configuration: { ...configuration(), image: targetImage } },
      ]),
      response([repatched]),
      response({ ...rollout("progressing"), target_configuration: { ...configuration(), image: targetImage } }),
    );

    await expect(
      rolloutRunnerApplicationImages(env, targetImage, deps, { reissueMatchingImageRollouts: true }),
    ).resolves.toEqual({
      updatedApplications: ["runner-standard-3"],
      skippedApplications: [],
    });
    expect(deps.fetch.mock.calls[4]?.[1]).toMatchObject({ method: "POST" });
  });

  it("does not repeat a completed rollout for an unchanged runner image", async () => {
    const targetImage = "registry.cloudflare.com/account/runner:new";
    const deployed = {
      ...application(resources, "runner-standard-3"),
      configuration: { ...configuration(), image: targetImage },
      health: { instances: { active: 0 } },
    };
    const deps = dependencies(
      response([deployed]),
      response([deployed]),
      response([{ ...rollout("completed"), target_configuration: { ...configuration(), image: targetImage } }]),
    );

    await expect(rolloutRunnerApplicationImages(env, targetImage, deps)).resolves.toEqual({
      updatedApplications: [],
      skippedApplications: [],
    });
    expect(deps.fetch).toHaveBeenCalledTimes(3);
  });

  it("recovers a daemonless-builder image PATCH that did not create its rollout", async () => {
    const targetImage = "registry.cloudflare.com/account/builder:new";
    const alreadyPatched = {
      ...application(resources, "runner-image-builder"),
      configuration: { ...configuration(), image: targetImage },
      health: { instances: { active: 0 } },
    };
    const deps = dependencies(
      response([alreadyPatched]),
      response([]),
      response({ ...rollout("completed"), target_configuration: { ...configuration(), image: targetImage } }),
    );

    await expect(rolloutRunnerImageBuilderApplication(env, targetImage, deps)).resolves.toEqual({
      kind: "rollout",
      applicationId: "application-id",
      rolloutId: "rollout-id",
    });
    expect(deps.fetch.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
  });

  it("does not repeat a completed daemonless-builder rollout", async () => {
    const targetImage = "registry.cloudflare.com/account/builder:new";
    const deployed = {
      ...application(resources, "runner-image-builder"),
      configuration: { ...configuration(), image: targetImage },
      health: { instances: { active: 0 } },
    };
    const deps = dependencies(
      response([deployed]),
      response([{ ...rollout("completed"), target_configuration: { ...configuration(), image: targetImage } }]),
    );

    await expect(rolloutRunnerImageBuilderApplication(env, targetImage, deps)).resolves.toEqual({
      kind: "ready",
      applicationId: "application-id",
    });
    expect(deps.fetch).toHaveBeenCalledTimes(2);
  });

  it("recreates a verified daemonless-builder rollout even when its mutable tag is already configured", async () => {
    const targetImage = "registry.cloudflare.com/account/builder:new";
    const deployed = {
      ...application(resources, "runner-image-builder"),
      configuration: { ...configuration(), image: targetImage },
      health: { instances: { active: 0 } },
    };
    const deps = dependencies(
      response([deployed]),
      response([{ ...rollout("completed"), target_configuration: { ...configuration(), image: targetImage } }]),
      response({ ...rollout("progressing"), target_configuration: { ...configuration(), image: targetImage } }),
    );

    await expect(rolloutRunnerImageBuilderApplication(env, targetImage, deps, { force: true })).resolves.toEqual({
      kind: "rollout",
      applicationId: "application-id",
      rolloutId: "rollout-id",
    });
    expect(deps.fetch.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
  });
});
