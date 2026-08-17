import { z } from "zod";

import type { RunnerResources } from "./runner-profiles";

export interface ContainersApiEnvironment {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_CONTAINERS_API_TOKEN: string;
  CUSTOM_RUNNER_APPLICATION: string;
  RUNNER_APPLICATION_PREFIX?: string;
  RUNNER_IMAGE_BUILDER_APPLICATION?: string;
}

export interface ContainersApiDependencies {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

const defaultDependencies: ContainersApiDependencies = {
  fetch: (input, init) => fetch(input, init),
};

export type ContainerRolloutStatus = "pending" | "progressing" | "completed" | "reverted" | "replaced";

const containerConfigurationSchema = z.object({
  image: z.string(),
  vcpu: z.number(),
  memory_mib: z.number(),
  disk: z.object({ size_mb: z.number() }),
});
const containerApplicationSchema = z.object({
  id: z.string(),
  name: z.string(),
  max_instances: z.number(),
  scheduling_policy: z.string(),
  rollout_active_grace_period: z.number().optional(),
  health: z.object({ instances: z.record(z.string(), z.number().optional()).optional() }).optional(),
  configuration: containerConfigurationSchema,
});
const rolloutStatusSchema = z.enum(["pending", "progressing", "completed", "reverted", "replaced"]);
const containerRolloutSchema = z.object({
  id: z.string(),
  status: rolloutStatusSchema,
  target_configuration: containerConfigurationSchema,
});
const registryPushCredentialsSchema = z.object({ username: z.string(), password: z.string() });
const containersApiResultSchema = z.json().optional();
const apiEnvelopeSchema = z.object({
  success: z.boolean().optional(),
  result: containersApiResultSchema,
  errors: z.array(z.object({ message: z.string().optional() })).optional(),
});

export type ContainerConfiguration = z.infer<typeof containerConfigurationSchema>;
export type ContainerApplication = z.infer<typeof containerApplicationSchema>;
type ContainerRollout = z.infer<typeof containerRolloutSchema>;
type ContainersApiResult = z.infer<typeof containersApiResultSchema>;

export type PrepareRunnerApplicationResult =
  | { kind: "ready"; applicationId: string }
  | { kind: "rollout"; applicationId: string; rolloutId: string };

export type ConfigureCustomMachineResult = PrepareRunnerApplicationResult;

export interface PrepareRunnerApplicationOptions {
  /**
   * A reconfigured idle custom slot must adopt the scheduler's exact ceiling.
   * Ordinary capacity updates remain grow-only to avoid undoing a newer job's
   * reservation.
   */
  exactMaxInstances?: boolean;
}

export interface UpdateCustomMachineMaxInstancesResult {
  applicationId: string;
  previousMaxInstances: number;
  maxInstances: number;
}

export interface ContainerRegistryPushCredentials {
  username: string;
  password: string;
}

export interface RolloutRunnerApplicationImagesResult {
  updatedApplications: string[];
  skippedApplications: string[];
}

export interface RolloutRunnerApplicationImagesOptions {
  /**
   * A durable Workflow is retrying after an interrupted image transition.
   * Reissue matching targets because history alone cannot prove the most
   * recent PATCH reached its own rollout (for example A→B→A).
   */
  reissueMatchingImageRollouts?: boolean;
}

export interface RolloutRunnerImageBuilderOptions {
  /**
   * Recreate a completed rollout after the Worker has independently verified
   * that a mutable private registry tag contains the pinned manifest.
   */
  force?: boolean;
}

export class CloudflareContainersApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CloudflareContainersApiError";
  }
}

function apiErrorDetail(body: z.infer<typeof apiEnvelopeSchema>): string | undefined {
  if (body.errors === undefined) {
    return undefined;
  }
  for (const error of body.errors) {
    if (error.message !== undefined) {
      return error.message;
    }
  }
  return undefined;
}

async function containersApiRequest(
  env: ContainersApiEnvironment,
  path: string,
  init: RequestInit,
  dependencies: ContainersApiDependencies,
): Promise<ContainersApiResult> {
  const response = await dependencies.fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/containers${path}`,
    {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${env.CLOUDFLARE_CONTAINERS_API_TOKEN}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    },
  );

  let rawBody;
  try {
    rawBody = await response.json();
  } catch {
    throw new CloudflareContainersApiError(
      `Cloudflare Containers API returned non-JSON status ${response.status}`,
      response.status,
    );
  }
  const parsedBody = apiEnvelopeSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    throw new CloudflareContainersApiError(
      `Cloudflare Containers API returned invalid JSON status ${response.status}`,
      response.status,
    );
  }
  const body = parsedBody.data;

  if (!response.ok || body.success !== true) {
    const detail = apiErrorDetail(body);
    throw new CloudflareContainersApiError(
      `Cloudflare Containers API ${response.status}${detail === undefined ? "" : `: ${detail}`}`,
      response.status,
    );
  }
  return body.result;
}

export async function createContainerRegistryPushCredentials(
  env: ContainersApiEnvironment,
  dependencies: ContainersApiDependencies = defaultDependencies,
): Promise<ContainerRegistryPushCredentials> {
  const result = await containersApiRequest(
    env,
    "/registries/registry.cloudflare.com/credentials",
    {
      method: "POST",
      body: JSON.stringify({ expiration_minutes: 15, permissions: ["pull", "push"] }),
    },
    dependencies,
  );
  const credentials = registryPushCredentialsSchema.safeParse(result);
  if (!credentials.success) {
    throw new CloudflareContainersApiError("Cloudflare returned invalid registry push credentials", 502);
  }
  return credentials.data;
}

function targetConfiguration(application: ContainerApplication, resources: RunnerResources): ContainerConfiguration {
  return {
    image: application.configuration.image,
    vcpu: resources.vcpu,
    memory_mib: resources.memoryMib,
    disk: { size_mb: resources.diskMb },
  };
}

/**
 * The Containers GET response may include read-only configuration metadata.
 * Send only fields accepted by the PATCH and rollout APIs.
 */
function writableConfiguration(configuration: ContainerConfiguration): ContainerConfiguration {
  return {
    image: configuration.image,
    vcpu: configuration.vcpu,
    memory_mib: configuration.memory_mib,
    disk: { size_mb: configuration.disk.size_mb },
  };
}

export function configurationMatches(configuration: ContainerConfiguration, resources: RunnerResources): boolean {
  return (
    configuration.vcpu === resources.vcpu &&
    configuration.memory_mib === resources.memoryMib &&
    configuration.disk.size_mb === resources.diskMb
  );
}

export async function findRunnerApplication(
  env: ContainersApiEnvironment,
  applicationName: string,
  dependencies: ContainersApiDependencies = defaultDependencies,
): Promise<ContainerApplication> {
  const result = await containersApiRequest(
    env,
    `/applications?name=${encodeURIComponent(applicationName)}`,
    { method: "GET" },
    dependencies,
  );
  const applications = z.array(containerApplicationSchema).safeParse(result);
  if (!applications.success) {
    throw new CloudflareContainersApiError("Cloudflare returned an invalid Container application list", 502);
  }
  const application = applications.data.find((candidate) => candidate.name === applicationName);
  if (application === undefined) {
    throw new CloudflareContainersApiError(
      `Container application ${applicationName} was not found; deploy the Worker before using this runner label`,
      404,
    );
  }
  return application;
}

async function listRollouts(
  env: ContainersApiEnvironment,
  applicationId: string,
  dependencies: ContainersApiDependencies,
): Promise<ContainerRollout[]> {
  const result = await containersApiRequest(
    env,
    `/applications/${encodeURIComponent(applicationId)}/rollouts?limit=100`,
    { method: "GET" },
    dependencies,
  );
  const rollouts = z.array(containerRolloutSchema).safeParse(result);
  if (!rollouts.success) {
    throw new CloudflareContainersApiError("Cloudflare returned an invalid Container rollout list", 502);
  }
  return rollouts.data;
}

async function patchApplication(
  env: ContainersApiEnvironment,
  application: ContainerApplication,
  configuration: ContainerConfiguration,
  maxInstances: number,
  dependencies: ContainersApiDependencies,
): Promise<void> {
  await containersApiRequest(
    env,
    `/applications/${encodeURIComponent(application.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        configuration: writableConfiguration(configuration),
        max_instances: maxInstances,
        scheduling_policy: application.scheduling_policy,
        rollout_active_grace_period: application.rollout_active_grace_period,
      }),
    },
    dependencies,
  );
}

/**
 * Image rollouts must not overwrite a concurrent scheduler capacity update.
 * The Container API accepts a partial PATCH, so send only the configuration
 * field and retain the application's current capacity ceiling server-side.
 */
async function patchApplicationImage(
  env: ContainersApiEnvironment,
  application: ContainerApplication,
  image: string,
  dependencies: ContainersApiDependencies,
): Promise<void> {
  await containersApiRequest(
    env,
    `/applications/${encodeURIComponent(application.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        configuration: writableConfiguration({ ...application.configuration, image }),
      }),
    },
    dependencies,
  );
}

/**
 * Begin an explicit image rollout after its desired configuration is present.
 * Keeping this separate from PATCH makes a retry safe when the PATCH succeeds
 * but the following rollout request is interrupted or rejected.
 */
async function createApplicationImageRollout(
  env: ContainersApiEnvironment,
  application: ContainerApplication,
  image: string,
  description: string,
  dependencies: ContainersApiDependencies,
): Promise<ContainerRollout> {
  const rollout = await containersApiRequest(
    env,
    `/applications/${encodeURIComponent(application.id)}/rollouts`,
    {
      method: "POST",
      body: JSON.stringify({
        description,
        strategy: "rolling",
        target_configuration: writableConfiguration({ ...application.configuration, image }),
        step_percentage: 100,
        kind: "full_auto",
      }),
    },
    dependencies,
  );
  const parsedRollout = containerRolloutSchema.safeParse(rollout);
  if (!parsedRollout.success) {
    throw new CloudflareContainersApiError("Cloudflare returned an invalid Container rollout", 502);
  }
  return parsedRollout.data;
}

function applicationHasLiveInstances(application: ContainerApplication): boolean {
  const instances = application.health?.instances;
  if (instances === undefined) {
    return false;
  }
  // Cloudflare can retain an assigned application slot after its Container
  // instance has stopped. Assignment alone therefore does not make the
  // application busy or prevent an image rollout.
  return ["active", "starting", "scheduling"].some((status) => (instances[status] ?? 0) > 0);
}

async function listApplications(
  env: ContainersApiEnvironment,
  dependencies: ContainersApiDependencies,
): Promise<ContainerApplication[]> {
  const result = await containersApiRequest(env, "/applications?per_page=100", { method: "GET" }, dependencies);
  const applications = z.array(containerApplicationSchema).safeParse(result);
  if (!applications.success) {
    throw new CloudflareContainersApiError("Cloudflare returned an invalid Container application list", 502);
  }
  return applications.data;
}

function runnerApplication(env: ContainersApiEnvironment, application: ContainerApplication): boolean {
  if (env.RUNNER_APPLICATION_PREFIX === undefined) {
    return false;
  }
  return (
    application.name.startsWith(`${env.RUNNER_APPLICATION_PREFIX}-`) &&
    application.name !== env.RUNNER_IMAGE_BUILDER_APPLICATION
  );
}

/**
 * Reconcile a stale runner-image rollout lease against Cloudflare before a
 * later build is allowed to take the builder slot. Durable Object lease time
 * alone is not proof that the external rollout request has finished.
 */
export async function runnerApplicationImageRolloutsAreActive(
  env: ContainersApiEnvironment,
  dependencies: ContainersApiDependencies = defaultDependencies,
): Promise<boolean> {
  const applications = (await listApplications(env, dependencies)).filter((application) =>
    runnerApplication(env, application),
  );
  for (const application of applications) {
    // eslint-disable-next-line no-await-in-loop -- each account application has an independent rollout history.
    const rollouts = await listRollouts(env, application.id, dependencies);
    if (rollouts.some((rollout) => rollout.status === "pending" || rollout.status === "progressing")) {
      return true;
    }
  }
  return false;
}

/**
 * A Worker deployment can roll the temporary public builder image before the
 * first Workflow has copied the pinned private image. Wait for that platform
 * rollout before forcing the verified private-builder rollout.
 */
export async function runnerImageBuilderApplicationRolloutsAreActive(
  env: ContainersApiEnvironment,
  dependencies: ContainersApiDependencies = defaultDependencies,
): Promise<boolean> {
  const applicationName = env.RUNNER_IMAGE_BUILDER_APPLICATION;
  if (applicationName === undefined || applicationName.trim() === "") {
    throw new CloudflareContainersApiError("RUNNER_IMAGE_BUILDER_APPLICATION is required", 500);
  }
  const application = await findRunnerApplication(env, applicationName, dependencies);
  const rollouts = await listRollouts(env, application.id, dependencies);
  return rollouts.some((rollout) => rollout.status === "pending" || rollout.status === "progressing");
}

/**
 * A bootstrap RPC can leave the temporary builder Container active briefly
 * after its private image has been copied. Image rollouts must wait for that
 * exact application to become idle instead of exhausting a retrying API step.
 */
export async function runnerImageBuilderApplicationHasLiveInstances(
  env: ContainersApiEnvironment,
  dependencies: ContainersApiDependencies = defaultDependencies,
): Promise<boolean> {
  const applicationName = env.RUNNER_IMAGE_BUILDER_APPLICATION;
  if (applicationName === undefined || applicationName.trim() === "") {
    throw new CloudflareContainersApiError("RUNNER_IMAGE_BUILDER_APPLICATION is required", 500);
  }
  return applicationHasLiveInstances(await findRunnerApplication(env, applicationName, dependencies));
}

/**
 * Starts an image rollout only for an idle runner application. Busy runners
 * keep their current image until the next source-image build request, while
 * the scheduler's max_instances reservation remains untouched.
 */
export async function rolloutRunnerApplicationImages(
  env: ContainersApiEnvironment,
  image: string,
  dependencies: ContainersApiDependencies = defaultDependencies,
  options: RolloutRunnerApplicationImagesOptions = {},
): Promise<RolloutRunnerApplicationImagesResult> {
  const applications = (await listApplications(env, dependencies)).filter((application) =>
    runnerApplication(env, application),
  );
  const updatedApplications: string[] = [];
  const skippedApplications: string[] = [];

  for (const listedApplication of applications) {
    // The scheduler can resize an idle custom application while an image build
    // is finishing. Re-read its configuration immediately before patching so
    // an image rollout never writes the stale resources from the initial list.
    // eslint-disable-next-line no-await-in-loop -- obtain the current configuration for this exact application.
    const application = await findRunnerApplication(env, listedApplication.name, dependencies);
    // eslint-disable-next-line no-await-in-loop -- a configuration rollout must be observed before the next application.
    const rollouts = await listRollouts(env, application.id, dependencies);
    if (rollouts.some((rollout) => rollout.status === "pending" || rollout.status === "progressing")) {
      skippedApplications.push(application.name);
      continue;
    }
    if (
      !options.reissueMatchingImageRollouts &&
      application.configuration.image === image &&
      rollouts.some((rollout) => rollout.status === "completed" && rollout.target_configuration.image === image)
    ) {
      continue;
    }
    if (applicationHasLiveInstances(application)) {
      skippedApplications.push(application.name);
      continue;
    }
    if (application.configuration.image !== image) {
      // eslint-disable-next-line no-await-in-loop -- preserve capacity by finishing one image patch before the next.
      await patchApplicationImage(env, application, image, dependencies);
    }
    // A scheduler admission may have resized this custom application while
    // the image-only PATCH was in flight. Read its current resources again so
    // the full rollout target cannot restore that stale machine shape.
    // eslint-disable-next-line no-await-in-loop -- this exact application owns its next rollout body.
    const current = await findRunnerApplication(env, application.name, dependencies);
    if (applicationHasLiveInstances(current)) {
      skippedApplications.push(application.name);
      continue;
    }
    // PATCH acceptance does not make the requested image visible in the
    // application's active configuration until a rollout applies it. Build
    // the rollout target from this freshly read configuration so concurrent
    // scheduler-owned resource changes survive while the new image remains
    // explicit below.
    // If a prior PATCH made it through but its rollout call did not, the
    // application already has this image here. Still create the rollout: a
    // desired configuration alone does not prove live instances moved.
    // eslint-disable-next-line no-await-in-loop -- each explicit rollout belongs to this application.
    await createApplicationImageRollout(
      env,
      current,
      image,
      "Cloudflare GitHub Actions runner image update",
      dependencies,
    );
    updatedApplications.push(application.name);
  }
  return { updatedApplications, skippedApplications };
}

/**
 * Switch the one-shot image builder to its account-private daemonless image.
 * This is isolated from runner rollouts because this builder never runs jobs
 * and must be idle before its image changes.
 */
export async function rolloutRunnerImageBuilderApplication(
  env: ContainersApiEnvironment,
  image: string,
  dependencies: ContainersApiDependencies = defaultDependencies,
  options: RolloutRunnerImageBuilderOptions = {},
): Promise<PrepareRunnerApplicationResult> {
  const applicationName = env.RUNNER_IMAGE_BUILDER_APPLICATION;
  if (applicationName === undefined || applicationName.trim() === "") {
    throw new CloudflareContainersApiError("RUNNER_IMAGE_BUILDER_APPLICATION is required", 500);
  }
  const application = await findRunnerApplication(env, applicationName, dependencies);
  const rollouts = await listRollouts(env, application.id, dependencies);
  const matchingActiveRollout = rollouts.find(
    (rollout) =>
      (rollout.status === "pending" || rollout.status === "progressing") &&
      rollout.target_configuration.image === image,
  );
  if (matchingActiveRollout !== undefined) {
    return { kind: "rollout", applicationId: application.id, rolloutId: matchingActiveRollout.id };
  }
  if (rollouts.some((rollout) => rollout.status === "pending" || rollout.status === "progressing")) {
    throw new CloudflareContainersApiError(
      "Another Container configuration is still rolling out; retry after it completes",
      409,
    );
  }
  if (
    !options.force &&
    application.configuration.image === image &&
    rollouts.some((rollout) => rollout.status === "completed" && rollout.target_configuration.image === image)
  ) {
    return { kind: "ready", applicationId: application.id };
  }
  if (applicationHasLiveInstances(application)) {
    throw new CloudflareContainersApiError("The Cloudflare runner image builder is still active", 409);
  }
  if (application.configuration.image !== image) {
    await patchApplicationImage(env, application, image, dependencies);
  }
  const rollout = await createApplicationImageRollout(
    env,
    application,
    image,
    "Cloudflare GitHub Actions private daemonless image builder",
    dependencies,
  );
  return { kind: "rollout", applicationId: application.id, rolloutId: rollout.id };
}

/**
 * Ensures a named runner application has enough capacity for already-admitted
 * jobs. Ordinary calls never lower a ceiling, so concurrent admissions cannot
 * accidentally undo a newer one-slot increase. A scheduler-controlled custom
 * reconfiguration may explicitly select an exact replacement ceiling.
 */
export async function prepareRunnerApplication(
  env: ContainersApiEnvironment,
  applicationName: string,
  desiredResources: RunnerResources | undefined,
  minimumMaxInstances: number,
  dependencies: ContainersApiDependencies = defaultDependencies,
  options: PrepareRunnerApplicationOptions = {},
): Promise<PrepareRunnerApplicationResult> {
  if (!Number.isSafeInteger(minimumMaxInstances) || minimumMaxInstances < 1) {
    throw new CloudflareContainersApiError("max_instances must be a positive integer", 400);
  }

  const application = await findRunnerApplication(env, applicationName, dependencies);
  if (desiredResources === undefined) {
    const targetMaxInstances = Math.max(application.max_instances, minimumMaxInstances);
    if (targetMaxInstances !== application.max_instances) {
      await patchApplication(env, application, application.configuration, targetMaxInstances, dependencies);
    }
    return { kind: "ready", applicationId: application.id };
  }

  const desiredConfiguration = targetConfiguration(application, desiredResources);
  const reconfiguring = !configurationMatches(application.configuration, desiredResources);
  const rollouts = await listRollouts(env, application.id, dependencies);
  const matchingActiveRollout = rollouts.find(
    (rollout) =>
      (rollout.status === "pending" || rollout.status === "progressing") &&
      configurationMatches(rollout.target_configuration, desiredResources),
  );
  if (matchingActiveRollout !== undefined) {
    return { kind: "rollout", applicationId: application.id, rolloutId: matchingActiveRollout.id };
  }

  const hasActiveRollout = rollouts.some((rollout) => rollout.status === "pending" || rollout.status === "progressing");
  if (hasActiveRollout) {
    throw new CloudflareContainersApiError(
      "Another Container configuration is still rolling out; retry after it completes",
      409,
    );
  }

  const targetMaxInstances = options.exactMaxInstances
    ? minimumMaxInstances
    : Math.max(application.max_instances, minimumMaxInstances);
  if (!reconfiguring && targetMaxInstances === application.max_instances) {
    return { kind: "ready", applicationId: application.id };
  }

  await patchApplication(env, application, desiredConfiguration, targetMaxInstances, dependencies);
  if (!reconfiguring) {
    return { kind: "ready", applicationId: application.id };
  }
  const rolloutResult = await containersApiRequest(
    env,
    `/applications/${encodeURIComponent(application.id)}/rollouts`,
    {
      method: "POST",
      body: JSON.stringify({
        description: `GitHub Actions runner: ${desiredResources.vcpu} vCPU, ${desiredResources.memoryMib} MiB, ${desiredResources.diskMb} MB`,
        strategy: "rolling",
        target_configuration: desiredConfiguration,
        step_percentage: 100,
        kind: "full_auto",
      }),
    },
    dependencies,
  );
  const rollout = containerRolloutSchema.safeParse(rolloutResult);
  if (!rollout.success) {
    throw new CloudflareContainersApiError("Cloudflare returned an invalid Container rollout", 502);
  }
  return { kind: "rollout", applicationId: application.id, rolloutId: rollout.data.id };
}

/**
 * Applies a scheduler-planned reclamation from an inactive application. A
 * later admission may raise the ceiling again, so an older reduction is
 * harmless and cannot over-admit.
 */
export async function reconcileRunnerApplicationCapacity(
  env: ContainersApiEnvironment,
  applicationName: string,
  targetMaxInstances: number,
  dependencies: ContainersApiDependencies = defaultDependencies,
): Promise<UpdateCustomMachineMaxInstancesResult> {
  if (!Number.isSafeInteger(targetMaxInstances) || targetMaxInstances < 1) {
    throw new CloudflareContainersApiError("max_instances must be a positive integer", 400);
  }
  const application = await findRunnerApplication(env, applicationName, dependencies);
  if (application.max_instances > targetMaxInstances) {
    await patchApplication(env, application, application.configuration, targetMaxInstances, dependencies);
  }
  return {
    applicationId: application.id,
    previousMaxInstances: application.max_instances,
    maxInstances: Math.min(application.max_instances, targetMaxInstances),
  };
}

export async function configureCustomMachine(
  env: ContainersApiEnvironment,
  resources: RunnerResources,
  dependencies: ContainersApiDependencies = defaultDependencies,
): Promise<ConfigureCustomMachineResult> {
  return prepareRunnerApplication(env, env.CUSTOM_RUNNER_APPLICATION, resources, 1, dependencies);
}

export async function updateCustomMachineMaxInstances(
  env: ContainersApiEnvironment,
  maxInstances: number,
  dependencies: ContainersApiDependencies = defaultDependencies,
): Promise<UpdateCustomMachineMaxInstancesResult> {
  const application = await findRunnerApplication(env, env.CUSTOM_RUNNER_APPLICATION, dependencies);
  if (!Number.isSafeInteger(maxInstances) || maxInstances < 1) {
    throw new CloudflareContainersApiError("max_instances must be a positive integer", 400);
  }
  if (application.max_instances !== maxInstances) {
    await patchApplication(env, application, application.configuration, maxInstances, dependencies);
  }
  return { applicationId: application.id, previousMaxInstances: application.max_instances, maxInstances };
}

export async function getContainerRolloutStatus(
  env: ContainersApiEnvironment,
  applicationId: string,
  rolloutId: string,
  dependencies: ContainersApiDependencies = defaultDependencies,
): Promise<ContainerRolloutStatus> {
  const result = await containersApiRequest(
    env,
    `/applications/${encodeURIComponent(applicationId)}/rollouts/${encodeURIComponent(rolloutId)}`,
    { method: "GET" },
    dependencies,
  );
  const rollout = containerRolloutSchema.safeParse(result);
  if (!rollout.success) {
    throw new CloudflareContainersApiError("Cloudflare returned an invalid Container rollout", 502);
  }
  return rollout.data.status;
}

export const getCustomMachineRolloutStatus = getContainerRolloutStatus;
