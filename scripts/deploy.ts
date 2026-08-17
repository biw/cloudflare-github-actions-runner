// @ts-nocheck

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

import { runnerImageBuilderBootstrapReference } from "../src/runner-image";
import {
  newRunnerInstallationId,
  parseRunnerOwnershipManifest,
  serializeRunnerOwnershipManifest,
} from "./resource-ownership";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const resourceMetricsDatabaseName = "cloudflare-github-actions-runner-metrics";
const legacyRunnerImageSourceBucketName = "cloudflare-github-actions-runner-image-source";
export const deploymentProgressPrefix = "CLOUDFLARE_RUNNER_SETUP_PHASE:";
export const defaultRunnerCacheBucketName = "cloudflare-github-actions-runner-cache";
export const defaultRunnerCacheMaxBytes = 100_000_000_000;
export const defaultRunnerCachePrefix = "cloudflare-github-actions-runner";
const wranglerTransientAuthenticationAttempts = 4;
const wranglerTransientAuthenticationRetryDelayMs = 1_000;

const nonEmptyStringSchema = z.string().trim().min(1);
const positiveIntegerSchema = z.number().int().positive();
const workerBindingSchema = z.object({
  name: z.string(),
  text: z.string().optional().catch(undefined),
  value: z.string().optional().catch(undefined),
  bucket_name: z.string().optional().catch(undefined),
});
const workerSettingsSchema = z.object({ bindings: z.array(z.json()).optional().catch([]) });

export class CommandExecutionError extends Error {
  constructor(message, commandOutput) {
    super(message);
    this.commandOutput = commandOutput;
  }
}

export function parseJsonc(source) {
  return JSON.parse(source.replace(/\/\/[^\n]*$/gmu, "").replace(/,\s*([}\]])/gmu, "$1"));
}

function reportDeploymentPhase(message) {
  console.log(`${deploymentProgressPrefix}${message}`);
}

export function resourceMetricsDatabaseFromList(value, name = resourceMetricsDatabaseName) {
  const parsedList = z.array(z.json()).safeParse(value);
  if (!parsedList.success) {
    throw new Error("Wrangler returned an invalid D1 database list");
  }
  const databaseSchema = z.object({ name: z.literal(name), uuid: z.string() });
  const database = parsedList.data.flatMap((candidate) => {
    const parsed = databaseSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  })[0];
  return database === undefined ? undefined : { name, id: database.uuid };
}

export function r2BucketExistsInList(value, name = defaultRunnerCacheBucketName) {
  return value.split(/\r?\n/gu).some((line) => line.match(/^name:\s+(.+?)\s*$/u)?.[1] === name);
}

export function r2LifecycleRuleExists(value, name) {
  return value.split(/\r?\n/gu).some((line) => line.match(/^name:\s+(.+?)\s*$/u)?.[1] === name);
}

export function validRunnerCacheBucketName(value) {
  const parsed = z.string().safeParse(value);
  return parsed.success && /^(?=.{3,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(parsed.data);
}

export function runnerCacheBytesFromGigabytes(value) {
  const parsed = z.union([z.number(), z.string()]).safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const gigabytes = Number(parsed.data);
  const bytes = gigabytes * 1_000_000_000;
  return Number.isSafeInteger(gigabytes) && gigabytes > 0 && Number.isSafeInteger(bytes) ? bytes : undefined;
}

function plainTextWorkerSetting(settings, name) {
  const parsedSettings = workerSettingsSchema.safeParse(settings);
  const binding = parsedSettings.success
    ? parsedSettings.data.bindings.flatMap((candidate) => {
        const parsed = workerBindingSchema.safeParse(candidate);
        return parsed.success && parsed.data.name === name ? [parsed.data] : [];
      })[0]
    : undefined;
  const value = binding?.text ?? binding?.value;
  return value;
}

export function runnerCacheConfigurationFromWorkerSettings(settings) {
  const parsedSettings = workerSettingsSchema.safeParse(settings);
  const bindings = parsedSettings.success
    ? parsedSettings.data.bindings.flatMap((candidate) => {
        const parsed = workerBindingSchema.safeParse(candidate);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  const cacheBinding = bindings.find(({ name }) => name === "RUNNER_CACHE");
  const sourceBinding = bindings.find(({ name }) => name === "RUNNER_IMAGE_SOURCE");
  const bucketName = cacheBinding?.bucket_name ?? sourceBinding?.bucket_name;
  const enabled = plainTextWorkerSetting(settings, "RUNNER_CACHE_ENABLED") !== "false" && cacheBinding !== undefined;
  const maxBytes = Number(plainTextWorkerSetting(settings, "RUNNER_CACHE_MAX_BYTES"));
  const prefix = plainTextWorkerSetting(settings, "RUNNER_CACHE_PREFIX");
  return {
    enabled,
    bucketName: bucketName ?? defaultRunnerCacheBucketName,
    maxBytes: Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : defaultRunnerCacheMaxBytes,
    prefix:
      prefix !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(prefix) ? prefix : defaultRunnerCachePrefix,
  };
}

export function runnerPoolGitHubOwnerFromWorkerSettings(settings) {
  // GITHUB_RUNNER_OWNER is a Worker secret so setup can switch the owner and
  // GitHub App credentials in one atomic `secret bulk` update. Keep this
  // public mirror solely for a friendly default the next time setup runs, and
  // retain the old binding as a migration fallback.
  return (
    plainTextWorkerSetting(settings, "RUNNER_POOL_GITHUB_OWNER") ??
    plainTextWorkerSetting(settings, "GITHUB_RUNNER_OWNER")
  );
}

export function runnerCacheConfigurationFromEnvironment(environment) {
  const explicitEnabled = environment.RUNNER_CACHE_ENABLED;
  if (explicitEnabled === undefined) {
    return undefined;
  }
  const enabled = explicitEnabled !== "false";
  const bucketName = environment.RUNNER_CACHE_BUCKET_NAME ?? defaultRunnerCacheBucketName;
  if (!validRunnerCacheBucketName(bucketName)) {
    throw new Error("RUNNER_CACHE_BUCKET_NAME must be a valid R2 bucket name");
  }
  const maxBytes = runnerCacheBytesFromGigabytes(environment.RUNNER_CACHE_MAX_SIZE_GB ?? "100");
  if (enabled && maxBytes === undefined) {
    throw new Error("RUNNER_CACHE_MAX_SIZE_GB must be a positive whole number of GB");
  }
  return {
    enabled,
    bucketName,
    maxBytes: maxBytes ?? defaultRunnerCacheMaxBytes,
    prefix: defaultRunnerCachePrefix,
  };
}

export function wranglerAuthenticationToken(value) {
  try {
    const parsed = z.object({ token: nonEmptyStringSchema }).safeParse(JSON.parse(value));
    if (parsed.success) {
      return parsed.data.token;
    }
  } catch {
    // An interactive Wrangler profile may include a banner before its JSON.
  }
  const json = value.match(/\{[\s\S]*\}\s*$/u)?.[0];
  if (json !== undefined) {
    try {
      const parsed = z.object({ token: nonEmptyStringSchema }).safeParse(JSON.parse(json));
      if (parsed.success) {
        return parsed.data.token;
      }
    } catch {
      // Continue to the deliberately strict plaintext token fallback.
    }
  }
  const token = value.trim();
  if (/^[A-Za-z0-9._-]+$/u.test(token)) {
    return token;
  }
  throw new Error("Wrangler did not return an authentication token for Container configuration checks");
}

/** Prefer the token already supplied by setup, avoiding a second OAuth refresh. */
export async function cloudflareAuthenticationToken(environment) {
  const suppliedToken = nonEmptyStringSchema.safeParse(environment.CLOUDFLARE_API_TOKEN);
  if (suppliedToken.success) {
    return suppliedToken.data;
  }
  const { stdout } = await runWrangler(["auth", "token", "--json"], environment, { quiet: true });
  return wranglerAuthenticationToken(stdout);
}

function run(command, args, environment = {}, { quiet = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const value = chunk.toString();
      stdout += value;
      if (!quiet) {
        process.stdout.write(value);
      }
    });
    child.stderr.on("data", (chunk) => {
      const value = chunk.toString();
      stderr += value;
      if (!quiet) {
        process.stderr.write(value);
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        reject(
          new CommandExecutionError(
            `${command} ${args.join(" ")} exited with status ${code ?? "unknown"}`,
            `${stdout}\n${stderr}`,
          ),
        );
      }
    });
  });
}

export function transientWranglerAuthenticationError(error) {
  return (
    error instanceof CommandExecutionError &&
    /The given account is not valid or is not authorized to access this service \[code: 7403\]/u.test(
      error.commandOutput,
    )
  );
}

export async function retryTransientWranglerAuthentication(operation, options = {}) {
  const {
    attempts = wranglerTransientAuthenticationAttempts,
    retryDelayMs = wranglerTransientAuthenticationRetryDelayMs,
  } = options;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- a rejected auth request has no side effect and is safe to retry.
      return await operation();
    } catch (error) {
      if (!transientWranglerAuthenticationError(error) || attempt === attempts) {
        throw error;
      }
    }
    // eslint-disable-next-line no-await-in-loop -- allow a concurrent Wrangler OAuth refresh to settle.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, retryDelayMs * 2 ** (attempt - 1)));
  }
  throw new Error("Wrangler authentication retry did not run");
}

async function runWrangler(args, environment, options) {
  const profile = nonEmptyStringSchema.safeParse(environment.WRANGLER_PROFILE);
  const quiet = options?.quiet === true;
  try {
    const result = await retryTransientWranglerAuthentication(() =>
      run(npxCommand, ["wrangler", ...args, ...(profile.success ? ["--profile", profile.data] : [])], environment, {
        ...options,
        quiet: true,
      }),
    );
    if (!quiet) {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
    }
    return result;
  } catch (error) {
    if (!quiet && error instanceof CommandExecutionError) {
      process.stderr.write(error.commandOutput);
    }
    throw error;
  }
}

async function existingResourceMetricsDatabase(environment) {
  const { stdout } = await runWrangler(["d1", "list", "--json"], environment, { quiet: true });
  return resourceMetricsDatabaseFromList(JSON.parse(stdout));
}

async function resourceMetricsDatabase(environment, { dryRun }, existing) {
  if (existing !== undefined) {
    return { ...existing, created: false };
  }
  if (dryRun) {
    throw new Error(
      `D1 database ${resourceMetricsDatabaseName} does not exist yet. Run pnpm run deploy once to create it before using deploy:dry-run.`,
    );
  }
  const created = await runWrangler(["d1", "create", resourceMetricsDatabaseName], environment);
  const id = `${created.stdout}\n${created.stderr}`.match(/database_id["\s:=]+([0-9a-f-]{36})/iu)?.[1];
  if (id === undefined) {
    throw new Error("Wrangler created the resource-metrics D1 database but did not return its database ID");
  }
  return { name: resourceMetricsDatabaseName, id, created: true };
}

async function cloudflareAccountRequest(token, accountId, path, options = {}) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}${path}`,
    {
      ...options,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...options.headers,
      },
    },
  );
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Cloudflare API ${response.status}: non-JSON response`);
  }
  const parsedBody = z
    .object({ success: z.boolean(), result: z.json().optional(), errors: z.array(z.json()).optional().catch([]) })
    .safeParse(body);
  if (!response.ok || !parsedBody.success || !parsedBody.data.success) {
    const detail = parsedBody.success
      ? parsedBody.data.errors.flatMap((error) => {
          const parsedError = z.object({ message: z.string() }).safeParse(error);
          return parsedError.success ? [parsedError.data.message] : [];
        })[0]
      : undefined;
    throw new Error(`Cloudflare API ${response.status}${detail === undefined ? "" : `: ${detail}`}`);
  }
  return parsedBody.data.result;
}

export function r2BucketIsPublic(managedDomain, customDomains) {
  const r2DevEnabled = z.object({ enabled: z.boolean() }).safeParse(managedDomain).data?.enabled === true;
  const wrappedDomains = z.object({ domains: z.array(z.json()) }).safeParse(customDomains);
  const directDomains = z.array(z.json()).safeParse(customDomains);
  const domains = wrappedDomains.success
    ? wrappedDomains.data.domains
    : directDomains.success
      ? directDomains.data
      : [];
  return r2DevEnabled || domains.some((domain) => z.object({ enabled: z.literal(true) }).safeParse(domain).success);
}

async function assertPrivateR2Bucket(environment, bucketName) {
  const token = await cloudflareAuthenticationToken(environment);
  const encodedBucketName = encodeURIComponent(bucketName);
  const [managedDomain, customDomains] = await Promise.all([
    cloudflareAccountRequest(
      token,
      environment.CLOUDFLARE_ACCOUNT_ID,
      `/r2/buckets/${encodedBucketName}/domains/managed`,
    ),
    cloudflareAccountRequest(
      token,
      environment.CLOUDFLARE_ACCOUNT_ID,
      `/r2/buckets/${encodedBucketName}/domains/custom`,
    ),
  ]);
  if (r2BucketIsPublic(managedDomain, customDomains)) {
    throw new Error(
      `R2 bucket ${bucketName} has a public r2.dev or custom domain. Disable public access before using it for the Cloudflare runner.`,
    );
  }
}

export function runnerStorageLifecycleRules(cacheConfiguration) {
  return [
    { name: "runner-image-source-expiry", prefix: "runner-image-source/", expireDays: 1 },
    ...(cacheConfiguration.enabled
      ? [
          { name: "runner-cache-proxy-expiry", prefix: `${cacheConfiguration.prefix}/npm/`, expireDays: 30 },
          {
            name: "actions-cache-v2-expiry",
            prefix: `${cacheConfiguration.prefix}/actions-cache-v2/`,
            expireDays: 30,
          },
        ]
      : []),
  ];
}

async function runnerStorageBucket(environment, cacheConfiguration, { dryRun, existingAllowed }) {
  const { stdout, stderr } = await runWrangler(["r2", "bucket", "list"], environment, { quiet: true });
  const exists = r2BucketExistsInList(`${stdout}\n${stderr}`, cacheConfiguration.bucketName);
  if (exists && !existingAllowed) {
    throw new Error(
      `R2 bucket ${cacheConfiguration.bucketName} already exists without this runner installation's ownership manifest. Choose a new bucket or explicitly adopt the existing runner pool.`,
    );
  }
  if (!exists && !dryRun) {
    await runWrangler(["r2", "bucket", "create", cacheConfiguration.bucketName], environment);
  }
  if (!dryRun) {
    await assertPrivateR2Bucket(environment, cacheConfiguration.bucketName);
    const lifecycle = await runWrangler(
      ["r2", "bucket", "lifecycle", "list", cacheConfiguration.bucketName],
      environment,
      { quiet: true },
    );
    const existingRules = `${lifecycle.stdout}\n${lifecycle.stderr}`;
    for (const { name, prefix, expireDays } of runnerStorageLifecycleRules(cacheConfiguration)) {
      if (r2LifecycleRuleExists(existingRules, name)) {
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- Wrangler lifecycle updates must remain ordered.
      await runWrangler(
        [
          "r2",
          "bucket",
          "lifecycle",
          "add",
          cacheConfiguration.bucketName,
          name,
          prefix,
          "--expire-days",
          String(expireDays),
          "--force",
        ],
        environment,
      );
    }
  }
  return { name: cacheConfiguration.bucketName, created: !exists };
}

async function retireLegacyRunnerImageSourceBucket(environment, storageBucketName, { dryRun }) {
  if (storageBucketName === legacyRunnerImageSourceBucketName) {
    return;
  }
  const { stdout, stderr } = await runWrangler(["r2", "bucket", "list"], environment, { quiet: true });
  if (!r2BucketExistsInList(`${stdout}\n${stderr}`, legacyRunnerImageSourceBucketName)) {
    return;
  }
  if (dryRun) {
    console.log(`Legacy runner-image source bucket ready to retire: ${legacyRunnerImageSourceBucketName}`);
    return;
  }
  try {
    await runWrangler(["r2", "bucket", "delete", legacyRunnerImageSourceBucketName], environment, { quiet: true });
    console.log(`Retired legacy runner-image source bucket: ${legacyRunnerImageSourceBucketName}`);
  } catch {
    console.log(
      `Legacy runner-image source bucket ${legacyRunnerImageSourceBucketName} could not be retired. It may still contain an expiring build object; rerun setup after one day or remove the empty bucket manually.`,
    );
  }
}

async function currentApplications(environment) {
  const token = await cloudflareAuthenticationToken(environment);
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(environment.CLOUDFLARE_ACCOUNT_ID)}/containers/applications`,
    { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    throw new Error(`Could not read Container application configuration (status ${response.status})`);
  }
  const body = z.object({ result: z.array(z.json()) }).safeParse(await response.json());
  if (!body.success) {
    throw new Error("Wrangler returned an invalid Container application list");
  }
  const details = new Map();
  for (const application of body.data.result) {
    const parsed = z.object({ name: z.string() }).passthrough().safeParse(application);
    if (parsed.success) {
      details.set(parsed.data.name, parsed.data);
    }
  }
  return details;
}

async function currentWorkflows(environment) {
  const token = await cloudflareAuthenticationToken(environment);
  const result = await cloudflareAccountRequest(token, environment.CLOUDFLARE_ACCOUNT_ID, "/workflows?per_page=100");
  return z.array(z.object({ id: nonEmptyStringSchema, name: nonEmptyStringSchema }).passthrough()).parse(result);
}

async function currentImages(environment) {
  const result = await runWrangler(["containers", "images", "list", "--json"], environment, { quiet: true });
  return z
    .array(z.object({ name: nonEmptyStringSchema, tags: z.array(nonEmptyStringSchema) }))
    .parse(JSON.parse(result.stdout));
}

export function unmanagedSetupCollisions(config, resources) {
  const applicationNames = new Set(resources.applications.map(({ name }) => name));
  const workflowNames = new Set(resources.workflows.map(({ name }) => name));
  const imageNames = new Set(resources.images.map(({ name }) => name));
  return [
    ...(resources.workerExists ? [`Worker ${config.name}`] : []),
    ...(resources.database === undefined ? [] : [`D1 database ${resources.database.name}`]),
    ...(resources.bucketExists ? [`R2 bucket ${resources.bucketName}`] : []),
    ...(config.containers ?? [])
      .filter(({ name }) => applicationNames.has(name))
      .map(({ name }) => `Container application ${name}`),
    ...(config.workflows ?? []).filter(({ name }) => workflowNames.has(name)).map(({ name }) => `Workflow ${name}`),
    ...[config.vars?.RUNNER_IMAGE_NAME, config.vars?.RUNNER_IMAGE_BUILDER_IMAGE_NAME]
      .filter((name) => imageNames.has(name))
      .map((name) => `registry image ${name}`),
  ];
}

export function ownershipManifestResourceCollisions(config, manifest, resources) {
  const expectedApplications = new Map(manifest.applications.map(({ id, name }) => [name, id]));
  const pendingApplications = new Set(manifest.pendingApplications.map(({ name }) => name));
  const configuredApplications = new Set((config.containers ?? []).map(({ name }) => name));
  const expectedWorkflows = new Map(manifest.workflows.map(({ id, name }) => [name, id]));
  const pendingWorkflows = new Set(manifest.pendingWorkflows.map(({ name }) => name));
  const configuredWorkflows = new Set((config.workflows ?? []).map(({ name }) => name));
  return [
    ...resources.applications.flatMap(({ id, name }) => {
      if (!configuredApplications.has(name)) return [];
      const expectedId = expectedApplications.get(name);
      if (expectedId === id || (expectedId === undefined && pendingApplications.has(name))) return [];
      return [`Container application ${name} is not owned by the existing installation manifest`];
    }),
    ...resources.workflows.flatMap(({ id, name }) => {
      if (!configuredWorkflows.has(name)) return [];
      const expectedId = expectedWorkflows.get(name);
      if (expectedId === id || (expectedId === undefined && pendingWorkflows.has(name))) return [];
      return [`Workflow ${name} is not owned by the existing installation manifest`];
    }),
  ];
}

function ownedPrefixes(cacheConfiguration) {
  return [
    "runner-image-source/",
    `${cacheConfiguration.prefix}/npm/`,
    `${cacheConfiguration.prefix}/actions-cache-v2/`,
  ];
}

function buildDeploymentOwnershipManifest({
  config,
  environment,
  installationId,
  cacheConfiguration,
  database,
  applications,
  workflows,
  images,
  previousManifest,
}) {
  const applicationNames = new Set((config.containers ?? []).map(({ name }) => name));
  const workflowNames = new Set((config.workflows ?? []).map(({ name }) => name));
  const imageNames = new Set([config.vars?.RUNNER_IMAGE_NAME, config.vars?.RUNNER_IMAGE_BUILDER_IMAGE_NAME]);
  const previous = previousManifest ?? {};
  const observedApplicationNames = new Set(applications.map(({ name }) => name));
  const observedWorkflowNames = new Set(workflows.map(({ name }) => name));
  const previousImages = new Set((previous.images ?? []).map(({ reference }) => reference));
  let createdImageReferences = [];
  try {
    createdImageReferences =
      z.array(nonEmptyStringSchema).safeParse(JSON.parse(environment.RUNNER_CREATED_IMAGE_REFERENCES ?? "[]")).data ??
      [];
  } catch {
    createdImageReferences = [];
  }
  const createdImages = new Set(createdImageReferences);
  const cloudflareTokenId = nonEmptyStringSchema.safeParse(environment.RUNNER_CLOUDFLARE_TOKEN_ID).data;
  const githubAppId = z.coerce.number().int().positive().safeParse(environment.RUNNER_GITHUB_APP_ID).data;
  const githubAppSlug = nonEmptyStringSchema.safeParse(environment.RUNNER_GITHUB_APP_SLUG).data;
  const githubAppOwner = nonEmptyStringSchema.safeParse(environment.RUNNER_GITHUB_APP_OWNER).data;
  return {
    version: 1,
    installationId,
    accountId: environment.CLOUDFLARE_ACCOUNT_ID,
    githubOwner: environment.RUNNER_POOL_GITHUB_OWNER,
    worker: { name: config.name },
    applications: applications
      .filter(({ name }) => applicationNames.has(name))
      .flatMap((application) => {
        const id = nonEmptyStringSchema.safeParse(application.id).data;
        return id === undefined ? [] : [{ id, name: application.name }];
      }),
    pendingApplications: [...applicationNames]
      .filter((name) => !observedApplicationNames.has(name))
      .map((name) => ({ name })),
    workflows: workflows.filter(({ name }) => workflowNames.has(name)).map(({ id, name }) => ({ id, name })),
    pendingWorkflows: [...workflowNames].filter((name) => !observedWorkflowNames.has(name)).map((name) => ({ name })),
    database: { id: database.id, name: database.name },
    bucket: { name: cacheConfiguration.bucketName, prefixes: ownedPrefixes(cacheConfiguration) },
    images: images
      .filter(({ name }) => imageNames.has(name))
      .flatMap(({ name, tags }) => tags.map((tag) => `${name}:${tag}`))
      .filter((reference) => {
        if (environment.RUNNER_ADOPT_EXISTING === "true") return true;
        return previousImages.has(reference) || createdImages.has(reference);
      })
      .map((reference) => ({ reference })),
    cloudflareToken: cloudflareTokenId === undefined ? previous.cloudflareToken : { id: cloudflareTokenId },
    githubApp:
      githubAppId === undefined || githubAppSlug === undefined || githubAppOwner === undefined
        ? previous.githubApp
        : { id: githubAppId, slug: githubAppSlug, owner: githubAppOwner },
  };
}

async function currentWorkerSettings(config, environment) {
  const token = await cloudflareAuthenticationToken(environment);
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(environment.CLOUDFLARE_ACCOUNT_ID)}/workers/scripts/${encodeURIComponent(config.name)}/settings`,
    { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } },
  );
  if (response.status === 404) {
    return undefined;
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Cloudflare API ${response.status}: non-JSON response`);
  }
  const parsedBody = z.object({ success: z.literal(true), result: z.record(z.string(), z.json()) }).safeParse(body);
  if (!response.ok || !parsedBody.success) {
    throw new Error(`Could not read current Worker settings (status ${response.status})`);
  }
  return parsedBody.data.result;
}

async function runnerCacheConfiguration(config, environment, settings) {
  const requested = runnerCacheConfigurationFromEnvironment(process.env);
  if (requested !== undefined) {
    return requested;
  }
  return settings === undefined
    ? {
        enabled: true,
        bucketName: defaultRunnerCacheBucketName,
        maxBytes: defaultRunnerCacheMaxBytes,
        prefix: defaultRunnerCachePrefix,
      }
    : runnerCacheConfigurationFromWorkerSettings(settings);
}

export function activeInstanceCount(application) {
  const parsed = z
    .object({
      health: z.object({
        instances: z.object({
          active: z.number().catch(0).default(0),
          assigned: z.number().catch(0).default(0),
          starting: z.number().catch(0).default(0),
          scheduling: z.number().catch(0).default(0),
        }),
      }),
    })
    .safeParse(application);
  if (!parsed.success) {
    return 0;
  }
  const instances = parsed.data.health.instances;
  return instances.active + instances.assigned + instances.starting + instances.scheduling;
}

export function runnerImageBuilderBootstrapConfiguration(config, environment) {
  const imageName = config.vars?.RUNNER_IMAGE_BUILDER_IMAGE_NAME;
  const reference = runnerImageBuilderBootstrapReference({
    CLOUDFLARE_ACCOUNT_ID: environment.CLOUDFLARE_ACCOUNT_ID,
    RUNNER_IMAGE_BUILDER_IMAGE_NAME: imageName,
  });
  if (reference === undefined) {
    throw new Error("wrangler.jsonc must define a valid RUNNER_IMAGE_BUILDER_IMAGE_NAME");
  }
  // A registry tag alone is not proof that it contains the pinned Kaniko
  // manifest. Always boot the builder from this public, controlled base and
  // make the Workflow verify and copy the source manifest before it starts a
  // private builder Container. A new deployment ID invalidates a Durable
  // Object's old readiness record after every Worker deployment.
  return {
    reference,
    image: "docker.io/library/ubuntu:24.04",
    deploymentId: randomUUID(),
  };
}

/**
 * Runner applications are rolled to an immutable image by the remote builder.
 * Preserve those tags on normal Worker deployments, but never preserve the
 * builder application's pinned daemonless image.
 */
export function preserveRunnerApplicationImages(config, applications) {
  const builderApplication = config.vars?.RUNNER_IMAGE_BUILDER_APPLICATION;
  for (const container of config.containers ?? []) {
    if (container?.name === builderApplication) {
      continue;
    }
    const currentImage = z
      .object({ configuration: z.object({ image: nonEmptyStringSchema }) })
      .safeParse(applications.get(container?.name));
    if (currentImage.success) {
      container.image = currentImage.data.configuration.image;
    }
  }
}

export function preserveCustomApplicationConfiguration(config, applications) {
  for (const container of config.containers ?? []) {
    const containerName = z.string().safeParse(container?.name);
    if (!containerName.success) {
      continue;
    }
    const current = applications.get(containerName.data);
    if (current === undefined) {
      continue;
    }
    // Retained ceilings are the scheduler's account-capacity cache. Preserve
    // them for every application; otherwise a source deployment would reset a
    // recently warmed preset profile back to its bootstrap value of one.
    const maxInstances = positiveIntegerSchema.safeParse(current.max_instances);
    if (maxInstances.success) {
      container.max_instances = maxInstances.data;
    }
    if (!containerName.data.startsWith(`${config.vars.CUSTOM_RUNNER_APPLICATION}`)) {
      continue;
    }
    const parsedCurrent = z
      .object({
        max_instances: positiveIntegerSchema,
        configuration: z.object({
          vcpu: z.number(),
          memory_mib: z.number(),
          disk: z.object({ size_mb: z.number() }),
          image: z.string(),
        }),
      })
      .safeParse(current);
    if (!parsedCurrent.success) {
      throw new Error(`Cloudflare returned an invalid configuration for ${containerName.data}`);
    }
    const configuration = parsedCurrent.data.configuration;
    if (activeInstanceCount(current) > 0 && container.image !== configuration.image) {
      // A custom application can be busy while an unrelated preset needs an
      // image update. Retain the live image for this one application so the
      // deployment is safe and the rest of the runner pool can roll forward.
      // The next deployment updates this custom application after it is idle.
      container.image = configuration.image;
    }
    container.instance_type = {
      vcpu: configuration.vcpu,
      memory_mib: configuration.memory_mib,
      disk_mb: configuration.disk.size_mb,
    };
    container.max_instances = parsedCurrent.data.max_instances;
  }
}

export function configureRunnerStorageBindings(config, cacheConfiguration) {
  const sourceBinding = config.r2_buckets?.find((bucket) => bucket?.binding === "RUNNER_IMAGE_SOURCE");
  if (sourceBinding === undefined) {
    throw new Error("wrangler.jsonc must define the RUNNER_IMAGE_SOURCE R2 binding");
  }
  sourceBinding.bucket_name = cacheConfiguration.bucketName;
  const cacheBindingIndex = config.r2_buckets?.findIndex((bucket) => bucket?.binding === "RUNNER_CACHE") ?? -1;
  if (cacheConfiguration.enabled) {
    if (cacheBindingIndex < 0) {
      throw new Error("wrangler.jsonc must define the RUNNER_CACHE R2 binding");
    }
    config.r2_buckets[cacheBindingIndex].bucket_name = cacheConfiguration.bucketName;
  } else if (cacheBindingIndex >= 0) {
    config.r2_buckets.splice(cacheBindingIndex, 1);
  }
}

async function generatedConfig(
  config,
  environment,
  metricsDatabase,
  cacheConfiguration,
  runnerPoolGitHubOwner,
  ownershipManifest,
) {
  const [applications, builderBootstrap] = await Promise.all([
    currentApplications(environment),
    runnerImageBuilderBootstrapConfiguration(config, environment),
  ]);
  preserveRunnerApplicationImages(config, applications);
  preserveCustomApplicationConfiguration(config, applications);
  // The generated file lives in the system temp directory, so preserve paths
  // that Wrangler would otherwise resolve relative to wrangler.jsonc.
  const mainPath = z.string().safeParse(config.main);
  if (mainPath.success) {
    config.main = join(projectRoot, mainPath.data);
  }
  const schemaPath = z.string().safeParse(config.$schema);
  if (schemaPath.success && !schemaPath.data.startsWith("/")) {
    config.$schema = join(projectRoot, schemaPath.data);
  }
  const metricsBinding = config.d1_databases?.find((database) => database?.binding === "RESOURCE_METRICS");
  if (metricsBinding === undefined) {
    throw new Error("wrangler.jsonc must define the RESOURCE_METRICS D1 binding");
  }
  metricsBinding.database_name = metricsDatabase.name;
  metricsBinding.database_id = metricsDatabase.id;
  const migrationsDirectory = z.string().safeParse(metricsBinding.migrations_dir);
  if (migrationsDirectory.success && !migrationsDirectory.data.startsWith("/")) {
    metricsBinding.migrations_dir = join(projectRoot, migrationsDirectory.data);
  }
  config.vars = {
    ...config.vars,
    RUNNER_CACHE_ENABLED: cacheConfiguration.enabled ? "true" : "false",
    RUNNER_CACHE_MAX_BYTES: String(cacheConfiguration.maxBytes),
    RUNNER_CACHE_PREFIX: cacheConfiguration.prefix,
    RUNNER_IMAGE_BUILDER_BOOTSTRAP_DEPLOYMENT_ID: builderBootstrap.deploymentId,
    RUNNER_INSTALLATION_ID: ownershipManifest.installationId,
    RUNNER_RESOURCE_MANIFEST: serializeRunnerOwnershipManifest(ownershipManifest),
  };
  if (runnerPoolGitHubOwner !== undefined) {
    config.vars.RUNNER_POOL_GITHUB_OWNER = runnerPoolGitHubOwner;
  }
  const builderContainer = config.containers?.find(
    (container) => container?.name === config.vars.RUNNER_IMAGE_BUILDER_APPLICATION,
  );
  if (builderContainer === undefined) {
    throw new Error("wrangler.jsonc must define the RUNNER_IMAGE_BUILDER_APPLICATION Container");
  }
  builderContainer.image = builderBootstrap.image;
  configureRunnerStorageBindings(config, cacheConfiguration);
  const directory = await mkdtemp(join(tmpdir(), "cloudflare-github-actions-runner-"));
  const path = join(directory, "wrangler.generated.json");
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  return { directory, path, builderBootstrap };
}

export async function main(arguments_ = process.argv.slice(2)) {
  const dryRun = arguments_.includes("--dry-run");
  const accountId = nonEmptyStringSchema.safeParse(process.env.CLOUDFLARE_ACCOUNT_ID);
  if (!accountId.success) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID is required for an account-safe deployment");
  }

  const environment = {
    CLOUDFLARE_ACCOUNT_ID: accountId.data,
  };
  const wranglerProfile = nonEmptyStringSchema.safeParse(process.env.WRANGLER_PROFILE);
  if (wranglerProfile.success) {
    environment.WRANGLER_PROFILE = wranglerProfile.data;
  }
  const runnerPoolOwner = nonEmptyStringSchema.safeParse(process.env.RUNNER_POOL_GITHUB_OWNER);
  if (runnerPoolOwner.success) {
    environment.RUNNER_POOL_GITHUB_OWNER = runnerPoolOwner.data;
  }
  for (const name of [
    "RUNNER_INSTALLATION_ID",
    "RUNNER_ADOPT_EXISTING",
    "RUNNER_CLOUDFLARE_TOKEN_ID",
    "RUNNER_GITHUB_APP_ID",
    "RUNNER_GITHUB_APP_SLUG",
    "RUNNER_GITHUB_APP_OWNER",
    "RUNNER_CREATED_IMAGE_REFERENCES",
  ]) {
    const value = nonEmptyStringSchema.safeParse(process.env[name]);
    if (value.success) {
      environment[name] = value.data;
    }
  }
  reportDeploymentPhase("Initializing Cloudflare deployment");
  const configText = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const config = parseJsonc(configText);
  console.log("Runner image: Cloudflare-hosted remote builder (no local Docker required)");
  reportDeploymentPhase("Checking managed Cloudflare resources");
  const existingWorkerSettings = await currentWorkerSettings(config, environment);
  const previousManifest = parseRunnerOwnershipManifest(
    plainTextWorkerSetting(existingWorkerSettings, "RUNNER_RESOURCE_MANIFEST"),
  );
  const requestedInstallationId = z.uuid().safeParse(environment.RUNNER_INSTALLATION_ID).data;
  const installationId = previousManifest?.installationId ?? requestedInstallationId ?? newRunnerInstallationId();
  const adoptExisting = environment.RUNNER_ADOPT_EXISTING === "true";
  const cacheConfiguration = await runnerCacheConfiguration(config, environment, existingWorkerSettings);
  const runnerPoolGitHubOwner =
    environment.RUNNER_POOL_GITHUB_OWNER ?? runnerPoolGitHubOwnerFromWorkerSettings(existingWorkerSettings);
  if (runnerPoolGitHubOwner === undefined) {
    throw new Error("RUNNER_POOL_GITHUB_OWNER is required before deployment can record resource ownership");
  }
  console.log(`GitHub runner owner: ${runnerPoolGitHubOwner}`);
  if (
    previousManifest !== undefined &&
    (previousManifest.accountId !== environment.CLOUDFLARE_ACCOUNT_ID ||
      previousManifest.githubOwner.toLowerCase() !== runnerPoolGitHubOwner.toLowerCase())
  ) {
    throw new Error("The existing ownership manifest belongs to a different Cloudflare account or GitHub owner");
  }
  const [existingDatabase, applicationsBefore, workflowsBefore, imagesBefore, bucketList] = await Promise.all([
    existingResourceMetricsDatabase(environment),
    currentApplications(environment),
    currentWorkflows(environment),
    currentImages(environment),
    runWrangler(["r2", "bucket", "list"], environment, { quiet: true }),
  ]);
  const bucketExists = r2BucketExistsInList(
    `${bucketList.stdout}\n${bucketList.stderr}`,
    cacheConfiguration.bucketName,
  );
  if (previousManifest === undefined && !adoptExisting) {
    const collisions = unmanagedSetupCollisions(config, {
      workerExists: existingWorkerSettings !== undefined,
      database: existingDatabase,
      bucketExists,
      bucketName: cacheConfiguration.bucketName,
      applications: [...applicationsBefore.values()],
      workflows: workflowsBefore,
      images: imagesBefore,
    });
    if (collisions.length > 0) {
      throw new Error(
        `Refusing to reuse resources without an ownership manifest: ${collisions.join(", ")}. Explicitly adopt the existing runner pool before deploying.`,
      );
    }
  }
  if (previousManifest !== undefined && !adoptExisting) {
    const collisions = ownershipManifestResourceCollisions(config, previousManifest, {
      applications: [...applicationsBefore.values()],
      workflows: workflowsBefore,
    });
    if (existingDatabase !== undefined && existingDatabase.id !== previousManifest.database.id) {
      collisions.push(`D1 database ${existingDatabase.name} changed immutable ID`);
    }
    if (collisions.length > 0) {
      throw new Error(`Refusing resources not owned by the existing installation: ${collisions.join(", ")}`);
    }
  }
  const existingResourcesAllowed = adoptExisting || previousManifest?.bucket.name === cacheConfiguration.bucketName;
  if (existingDatabase !== undefined && !existingResourcesAllowed) {
    throw new Error(`D1 database ${existingDatabase.name} already exists without runner ownership metadata`);
  }
  const metricsDatabase = await resourceMetricsDatabase(environment, { dryRun }, existingDatabase);
  console.log(`Resource-trace D1 database: ${metricsDatabase.name}`);
  reportDeploymentPhase("Configuring the dependency cache");
  const storageBucket = await runnerStorageBucket(environment, cacheConfiguration, {
    dryRun,
    existingAllowed: existingResourcesAllowed,
  });
  console.log(`Private runner R2 storage bucket: ${storageBucket.name} (image sources expire after one day)`);
  if (!cacheConfiguration.enabled) {
    console.log("Runner dependency cache: GitHub-hosted (R2 disabled)");
  } else {
    console.log(
      `Runner dependency cache: R2 enabled (FIFO maximum ${(cacheConfiguration.maxBytes / 1_000_000_000).toLocaleString()} GB)`,
    );
  }
  const ownershipManifest = buildDeploymentOwnershipManifest({
    config,
    environment: { ...environment, RUNNER_POOL_GITHUB_OWNER: runnerPoolGitHubOwner },
    installationId,
    cacheConfiguration,
    database: metricsDatabase,
    applications: [...applicationsBefore.values()],
    workflows: workflowsBefore,
    images: imagesBefore,
    previousManifest,
  });
  reportDeploymentPhase("Preparing Worker and Container configuration");
  const generated = await generatedConfig(
    config,
    environment,
    metricsDatabase,
    cacheConfiguration,
    runnerPoolGitHubOwner,
    ownershipManifest,
  );
  try {
    console.log(
      `Private daemonless image builder: verified during the first remote build (${generated.builderBootstrap.reference})`,
    );
    if (!dryRun) {
      reportDeploymentPhase("Installing Worker database migrations");
      console.log("Applying resource-trace D1 migrations...");
      await runWrangler(
        ["d1", "migrations", "apply", metricsDatabase.name, "--remote", "--config", generated.path],
        environment,
      );
    }
    const args = ["deploy", "--config", generated.path];
    if (dryRun) {
      args.push("--dry-run");
    }
    reportDeploymentPhase(
      dryRun ? "Building the Worker deployment preview" : "Building, uploading, and deploying the Worker",
    );
    console.log(dryRun ? "Checking Worker deployment..." : "Deploying Worker...");
    await runWrangler(args, environment);
    await retireLegacyRunnerImageSourceBucket(environment, storageBucket.name, { dryRun });
  } finally {
    await rm(generated.directory, { recursive: true, force: true });
  }
  return undefined;
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
