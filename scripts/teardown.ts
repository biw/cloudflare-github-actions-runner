// @ts-nocheck

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { checkbox, confirm, select } from "@inquirer/prompts";
import { z } from "zod";

import {
  githubOwnerLabel,
  orderedGitHubRunnerOwners,
  parseCloudflareIdentity,
  parseGitHubAppOwners,
  parseWranglerAuthProfiles,
} from "./setup";
import { buildOwnedTeardownPlan, parseRunnerOwnershipManifest } from "./resource-ownership";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const githubCommand = process.platform === "win32" ? "gh.exe" : "gh";
const cloudflareApiBaseUrl = "https://api.cloudflare.com/client/v4";
const r2ObjectDeleteConcurrency = 25;
const githubSecretNames = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_WEBHOOK_SECRET",
  "GITHUB_RUNNER_OWNER",
  "PENDING_GITHUB_APP_ID",
  "PENDING_GITHUB_APP_PRIVATE_KEY",
  "PENDING_GITHUB_APP_WEBHOOK_SECRET",
];

const nonEmptyStringSchema = z.string().trim().min(1);
const accountSchema = z.object({ id: nonEmptyStringSchema, name: nonEmptyStringSchema });
const bindingSchema = z.object({
  name: z.string().optional().catch(undefined),
  binding: z.string().optional().catch(undefined),
  bucket_name: z.string().optional().catch(undefined),
  text: z.string().optional().catch(undefined),
  value: z.string().optional().catch(undefined),
});
const workerSettingsSchema = z.object({ bindings: z.array(z.json()).optional().catch([]) });
const githubAppStatusSchema = z.object({
  configured: z.boolean(),
  valid: z.boolean(),
  id: z.number().int().positive().optional(),
  slug: z.string().optional(),
  owner: z.object({ login: z.string(), type: z.string().optional() }).optional(),
  installations: z.array(z.object({ account: z.string() })).catch([]),
});

export class TeardownCommandError extends Error {
  constructor(message, output = "") {
    super(message);
    this.output = output;
  }
}

export function parseTeardownConfig(source) {
  return JSON.parse(source.replace(/\/\/[^\n]*$/gmu, "").replace(/,\s*([}\]])/gmu, "$1"));
}

function runCommand(command, arguments_, options = {}) {
  const { environment = {}, input, quiet = false } = options;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      cwd: projectRoot,
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const value = String(chunk);
      stdout += value;
      if (!quiet) {
        process.stdout.write(value);
      }
    });
    child.stderr.on("data", (chunk) => {
      const value = String(chunk);
      stderr += value;
      if (!quiet) {
        process.stderr.write(value);
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(
        new TeardownCommandError(
          `${command} ${arguments_.join(" ")} exited with status ${code ?? "unknown"}`,
          `${stdout}\n${stderr}`,
        ),
      );
    });
    child.stdin.end(input);
  });
}

function wranglerArguments(arguments_, profile) {
  return ["wrangler", ...arguments_, ...(profile === undefined ? [] : ["--profile", profile])];
}

function cloudflareEnvironment(account) {
  return { CLOUDFLARE_ACCOUNT_ID: account.account.id, WRANGLER_PROFILE: account.profile };
}

async function runWrangler(arguments_, account, options = {}) {
  return runCommand(npxCommand, wranglerArguments(arguments_, account.profile), {
    ...options,
    environment: { ...cloudflareEnvironment(account), ...options.environment },
  });
}

async function cloudflareProfileToken(profile) {
  const result = await runCommand(npxCommand, wranglerArguments(["auth", "token", "--json"], profile), {
    quiet: true,
  });
  const parsed = z.object({ token: nonEmptyStringSchema }).safeParse(JSON.parse(result.stdout));
  if (!parsed.success) {
    throw new Error(`Wrangler profile ${profile} does not contain a usable Cloudflare credential`);
  }
  return parsed.data.token;
}

async function cloudflareApiRequest(token, accountId, path, options = {}) {
  const response = await fetch(`${cloudflareApiBaseUrl}/accounts/${encodeURIComponent(accountId)}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
  if (options.allowNotFound === true && response.status === 404) {
    return undefined;
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Cloudflare API ${response.status}: non-JSON response`);
  }
  const parsed = z
    .object({
      success: z.boolean(),
      result: z.json().optional(),
      errors: z.array(z.json()).optional().catch([]),
      result_info: z.json().optional(),
    })
    .safeParse(body);
  if (!response.ok || !parsed.success || !parsed.data.success) {
    const detail = parsed.success
      ? parsed.data.errors.flatMap((error) => {
          const candidate = z.object({ message: z.string() }).safeParse(error);
          return candidate.success ? [candidate.data.message] : [];
        })[0]
      : undefined;
    throw new Error(`Cloudflare API ${response.status}${detail === undefined ? "" : `: ${detail}`}`);
  }
  return { result: parsed.data.result, resultInfo: parsed.data.result_info };
}

function profilePreference(candidate, preferredProfile) {
  if (candidate.profile === preferredProfile) {
    return 0;
  }
  return candidate.profile === "default" ? 2 : 1;
}

export function collapseTeardownAccountCandidates(candidates, preferredProfile = process.env.WRANGLER_PROFILE) {
  const accounts = new Map();
  for (const candidate of candidates) {
    const parsed = accountSchema.safeParse(candidate?.account);
    if (!parsed.success || nonEmptyStringSchema.safeParse(candidate?.profile).success === false) {
      continue;
    }
    const current = accounts.get(parsed.data.id);
    if (
      current === undefined ||
      profilePreference(candidate, preferredProfile) < profilePreference(current, preferredProfile) ||
      (profilePreference(candidate, preferredProfile) === profilePreference(current, preferredProfile) &&
        candidate.profile.localeCompare(current.profile) < 0)
    ) {
      accounts.set(parsed.data.id, candidate);
    }
  }
  return [...accounts.values()].sort(
    (left, right) =>
      left.account.name.localeCompare(right.account.name) || left.account.id.localeCompare(right.account.id),
  );
}

async function cloudflareAccounts() {
  const profilesResult = await runCommand(npxCommand, ["wrangler", "auth", "list"], { quiet: true });
  const profiles = parseWranglerAuthProfiles(`${profilesResult.stdout}\n${profilesResult.stderr}`);
  const identities = await Promise.all(
    profiles.map(async (profile) => {
      try {
        const token = await cloudflareProfileToken(profile);
        const identity = await runCommand(npxCommand, ["wrangler", "whoami", "--json"], {
          environment: { CLOUDFLARE_API_TOKEN: token },
          quiet: true,
        });
        return { profile, identity: parseCloudflareIdentity(identity.stdout) };
      } catch {
        return undefined;
      }
    }),
  );
  return collapseTeardownAccountCandidates(
    identities.flatMap((candidate) =>
      candidate === undefined
        ? []
        : candidate.identity.accounts.map((account) => ({
            account,
            email: candidate.identity.email,
            profile: candidate.profile,
          })),
    ),
  );
}

async function githubAccounts() {
  const [user, memberships] = await Promise.all([
    runCommand(githubCommand, ["api", "user"], { quiet: true }),
    runCommand(githubCommand, ["api", "--paginate", "--slurp", "user/memberships/orgs?per_page=100"], {
      quiet: true,
    }),
  ]);
  return parseGitHubAppOwners(user.stdout, memberships.stdout);
}

export function githubTeardownOwnerMatches(status, owner) {
  const appOwner = nonEmptyStringSchema.safeParse(status?.owner?.login);
  const selectedOwner = nonEmptyStringSchema.safeParse(owner?.login);
  return appOwner.success && selectedOwner.success && appOwner.data.toLowerCase() === selectedOwner.data.toLowerCase();
}

function assertGitHubTeardownOwner(status, owner) {
  if (!githubTeardownOwnerMatches(status, owner)) {
    throw new Error(
      `The selected GitHub owner ${owner.login} does not own this runner pool's App (${status.owner?.login ?? "unknown"}). Nothing was deleted.`,
    );
  }
}

export async function promptForTeardownScopes(prompt: any = checkbox) {
  const selected = await prompt({
    message: "Which parts of setup should be removed?",
    required: false,
    choices: [
      {
        name: "Cloudflare setup",
        value: "cloudflare",
        description: "Runner pool, managed data, images, and dedicated account token",
        checked: true,
      },
      {
        name: "GitHub setup",
        value: "github",
        description: "GitHub App, installations, and Worker credentials",
        checked: true,
      },
    ],
  });
  return { cloudflare: selected.includes("cloudflare"), github: selected.includes("github") };
}

export function promptForTeardownConfirmation(prompt: any = confirm) {
  return prompt({ message: "Would you like to delete these resources?", default: false });
}

export async function promptForGitHubTeardownOwner(owners, previouslyConfiguredOwner, prompt: any = select) {
  return prompt({
    message: "Which GitHub account or organization should be torn down?",
    choices: orderedGitHubRunnerOwners(owners, previouslyConfiguredOwner).map(({ owner, previouslyConfigured }) => ({
      name: githubOwnerLabel(owner, { previouslyConfigured }),
      value: owner,
    })),
  });
}

function managedNames(config, workerSettings) {
  const parsedSettings = workerSettingsSchema.safeParse(workerSettings);
  const managedR2Bindings = new Set(["RUNNER_CACHE", "RUNNER_IMAGE_SOURCE"]);
  const configuredBuckets = new Map(
    (config.r2_buckets ?? []).flatMap((binding) => {
      const parsed = bindingSchema.safeParse(binding);
      const name = parsed.success ? (parsed.data.binding ?? parsed.data.name) : undefined;
      return name !== undefined && managedR2Bindings.has(name) && parsed.data.bucket_name !== undefined
        ? [[name, parsed.data.bucket_name]]
        : [];
    }),
  );
  const deployedBuckets = new Map(
    parsedSettings.success
      ? parsedSettings.data.bindings.flatMap((binding) => {
          const parsed = bindingSchema.safeParse(binding);
          const name = parsed.success ? (parsed.data.name ?? parsed.data.binding) : undefined;
          return name !== undefined && managedR2Bindings.has(name) && parsed.data.bucket_name !== undefined
            ? [[name, parsed.data.bucket_name]]
            : [];
        })
      : [],
  );
  // A deployed binding is authoritative: in particular, do not delete the
  // default cache bucket when setup selected a different custom bucket or
  // disabled R2 caching. Fall back to config names only for partial setups
  // that never produced a Worker.
  const bucketNames = parsedSettings.success ? deployedBuckets.values() : configuredBuckets.values();
  return {
    worker: nonEmptyStringSchema.parse(config.name),
    applications: new Set(
      (config.containers ?? []).flatMap((application) =>
        nonEmptyStringSchema.safeParse(application?.name).success ? [application.name] : [],
      ),
    ),
    workflows: new Set(
      (config.workflows ?? []).flatMap((workflow) =>
        nonEmptyStringSchema.safeParse(workflow?.name).success ? [workflow.name] : [],
      ),
    ),
    databases: new Set(
      (config.d1_databases ?? []).flatMap((database) =>
        nonEmptyStringSchema.safeParse(database?.database_name).success ? [database.database_name] : [],
      ),
    ),
    buckets: new Set(bucketNames),
    images: new Set(
      [config.vars?.RUNNER_IMAGE_NAME, config.vars?.RUNNER_IMAGE_BUILDER_IMAGE_NAME].flatMap((name) =>
        nonEmptyStringSchema.safeParse(name).success ? [name] : [],
      ),
    ),
  };
}

export function buildTeardownInventory(config, resources) {
  const names = managedNames(config, resources.workerSettings);
  const parsedSettings = workerSettingsSchema.safeParse(resources.workerSettings);
  const bindings = parsedSettings.success
    ? parsedSettings.data.bindings.flatMap((binding) => {
        const parsed = bindingSchema.safeParse(binding);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  const publicSetting = (name) => {
    const binding = bindings.find((candidate) => candidate.name === name || candidate.binding === name);
    return nonEmptyStringSchema.safeParse(binding?.text ?? binding?.value).data;
  };
  const bindingNames = new Set(bindings.flatMap((binding) => [binding.name, binding.binding]).filter(Boolean));
  const applications = z
    .array(z.object({ id: nonEmptyStringSchema, name: nonEmptyStringSchema }))
    .parse(resources.applications)
    .filter((application) => names.applications.has(application.name));
  const workflows = z
    .array(z.object({ id: nonEmptyStringSchema, name: nonEmptyStringSchema }))
    .parse(resources.workflows)
    .filter((workflow) => names.workflows.has(workflow.name));
  const databases = z
    .array(
      z.object({
        name: nonEmptyStringSchema,
        id: nonEmptyStringSchema.optional(),
        uuid: nonEmptyStringSchema.optional(),
      }),
    )
    .parse(resources.databases)
    .filter((database) => names.databases.has(database.name))
    .map((database) => ({ ...database, id: database.id ?? database.uuid }));
  const buckets = z
    .array(z.object({ name: nonEmptyStringSchema, jurisdiction: z.string().nullable().optional() }))
    .parse(resources.buckets)
    .filter((bucket) => names.buckets.has(bucket.name));
  const images = z
    .array(z.object({ name: nonEmptyStringSchema, tags: z.array(nonEmptyStringSchema) }))
    .parse(resources.images)
    .filter((image) => names.images.has(image.name))
    .flatMap((image) => image.tags.map((tag) => `${image.name}:${tag}`));
  return {
    worker: resources.workerSettings === undefined ? undefined : names.worker,
    githubOwner: publicSetting("RUNNER_POOL_GITHUB_OWNER") ?? publicSetting("GITHUB_RUNNER_OWNER"),
    githubAppConfigured:
      bindingNames.has("GITHUB_APP_ID") &&
      bindingNames.has("GITHUB_APP_PRIVATE_KEY") &&
      bindingNames.has("GITHUB_APP_WEBHOOK_SECRET"),
    ownershipManifest: parseRunnerOwnershipManifest(publicSetting("RUNNER_RESOURCE_MANIFEST")),
    applications,
    workflows,
    databases,
    buckets,
    images,
  };
}

async function inspectWorkerRunnerOwnership(account, token, workerName, installationId) {
  const baseUrl = await workerBaseUrl(token, account.account.id, workerName);
  const response = await fetch(`${baseUrl}/v1/setup/resource-ownership`, {
    headers: { "X-Runner-Installation-Id": installationId },
  });
  if (!response.ok) {
    throw new Error(`Could not verify runner resource ownership (status ${response.status})`);
  }
  return z
    .object({
      resources: z.array(
        z.object({
          id: nonEmptyStringSchema,
          type: nonEmptyStringSchema,
          tags: z.record(z.string(), z.string()),
        }),
      ),
    })
    .parse(await response.json()).resources;
}

async function inspectR2BucketOwnership(token, accountId, bucket) {
  let cursor;
  let managedObjects = 0;
  let unknownObjects = 0;
  do {
    const query = new URLSearchParams({ per_page: "1000" });
    if (cursor !== undefined) query.set("cursor", cursor);
    // eslint-disable-next-line no-await-in-loop -- Cloudflare returns the next cursor with each R2 page.
    const page = await cloudflareApiRequest(
      token,
      accountId,
      `/r2/buckets/${encodeURIComponent(bucket.name)}/objects?${query}`,
    );
    const objects = z.array(z.object({ key: nonEmptyStringSchema })).parse(page.result);
    for (const { key } of objects) {
      if (bucket.prefixes.some((prefix) => key.startsWith(prefix))) managedObjects += 1;
      else unknownObjects += 1;
    }
    cursor = z.object({ cursor: z.string().optional() }).safeParse(page.resultInfo).data?.cursor;
  } while (cursor !== undefined && cursor !== "");
  return { name: bucket.name, managedObjects, unknownObjects };
}

async function listR2Buckets(token, accountId) {
  const buckets = [];
  let cursor;
  do {
    const query = new URLSearchParams({ per_page: "1000" });
    if (cursor !== undefined) {
      query.set("cursor", cursor);
    }
    // eslint-disable-next-line no-await-in-loop -- Cloudflare returns the next cursor with each page.
    const page = await cloudflareApiRequest(token, accountId, `/r2/buckets?${query}`);
    const parsed = z.object({ buckets: z.array(z.json()).optional().catch([]) }).safeParse(page.result);
    if (!parsed.success) {
      throw new Error("Cloudflare returned an invalid R2 bucket list");
    }
    buckets.push(...parsed.data.buckets);
    cursor = z.object({ cursor: z.string().optional() }).safeParse(page.resultInfo).data?.cursor;
  } while (cursor !== undefined && cursor !== "");
  return buckets;
}

async function inspectCloudflareResources(config, account, token) {
  const accountId = account.account.id;
  const [worker, applications, images, databases, workflows, buckets] = await Promise.all([
    cloudflareApiRequest(token, accountId, `/workers/scripts/${encodeURIComponent(config.name)}/settings`, {
      allowNotFound: true,
    }),
    runWrangler(["containers", "list", "--json"], account, { quiet: true }),
    runWrangler(["containers", "images", "list", "--json"], account, { quiet: true }),
    runWrangler(["d1", "list", "--json"], account, { quiet: true }),
    cloudflareApiRequest(token, accountId, "/workflows?per_page=100"),
    listR2Buckets(token, accountId),
  ]);
  return buildTeardownInventory(config, {
    workerSettings: worker?.result,
    applications: JSON.parse(applications.stdout),
    images: JSON.parse(images.stdout),
    databases: JSON.parse(databases.stdout),
    workflows: z.array(z.json()).parse(workflows.result),
    buckets,
  });
}

export function githubAppSettingsUrl(status) {
  const slug = nonEmptyStringSchema.safeParse(status?.slug);
  const owner = nonEmptyStringSchema.safeParse(status?.owner?.login);
  if (!slug.success || !owner.success) {
    return undefined;
  }
  return status.owner?.type?.toLowerCase() === "organization"
    ? `https://github.com/organizations/${encodeURIComponent(owner.data)}/settings/apps/${encodeURIComponent(slug.data)}`
    : `https://github.com/settings/apps/${encodeURIComponent(slug.data)}`;
}

function openExternalUrl(url) {
  const command =
    process.platform === "darwin"
      ? { command: "open", arguments: [url] }
      : process.platform === "win32"
        ? { command: "cmd", arguments: ["/c", "start", "", url] }
        : { command: "xdg-open", arguments: [url] };
  const child = spawn(command.command, command.arguments, { detached: true, stdio: "ignore" });
  child.once("error", () => console.log(`Could not open a browser automatically. Open this URL instead:\n${url}\n`));
  child.unref();
}

async function workerBaseUrl(token, accountId, workerName) {
  const response = await cloudflareApiRequest(token, accountId, "/workers/subdomain");
  const parsed = z.object({ subdomain: nonEmptyStringSchema }).safeParse(response.result);
  if (!parsed.success) {
    throw new Error("Cloudflare did not return the account Workers subdomain");
  }
  return `https://${workerName}.${parsed.data.subdomain}.workers.dev`;
}

export function cloudflareAccountTokenSettingsUrl(accountId) {
  return `https://dash.cloudflare.com/${encodeURIComponent(accountId)}/api-tokens`;
}

async function authorizedWorkerRequest(url, token, options = {}) {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- workers.dev can briefly serve the previous secret version.
    const response = await fetch(url, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...options.headers },
    });
    if (response.status !== 401 || attempt === 30) {
      return response;
    }
    // eslint-disable-next-line no-await-in-loop -- wait for the new Worker secret version to propagate.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error("Worker teardown authorization check did not run");
}

async function deleteWorkerSecrets(account, names) {
  await runWrangler(["secret", "bulk"], account, {
    input: `${JSON.stringify(Object.fromEntries(names.map((name) => [name, null])))}\n`,
    quiet: true,
  });
}

async function workerGitHubAppStatus(baseUrl, setupToken) {
  const response = await authorizedWorkerRequest(`${baseUrl}/v1/setup/github-app`, setupToken);
  if (!response.ok) {
    throw new Error(`Could not inspect the runner GitHub App (status ${response.status})`);
  }
  return githubAppStatusSchema.parse(await response.json());
}

async function inspectGitHubApp(account, token, workerName) {
  const setupToken = randomBytes(32).toString("hex");
  const baseUrl = await workerBaseUrl(token, account.account.id, workerName);
  await runWrangler(["secret", "put", "RUNNER_SETUP_VALIDATION_TOKEN"], account, {
    input: `${setupToken}\n`,
    quiet: true,
  });
  try {
    return await workerGitHubAppStatus(baseUrl, setupToken);
  } finally {
    try {
      await runWrangler(["secret", "delete", "RUNNER_SETUP_VALIDATION_TOKEN"], account, {
        input: "y\n",
        quiet: true,
      });
    } catch {
      console.error("Warning: could not remove the temporary Worker teardown credential");
    }
  }
}

async function inspectCloudflareContainersToken(account, token, workerName) {
  const setupToken = randomBytes(32).toString("hex");
  const baseUrl = await workerBaseUrl(token, account.account.id, workerName);
  await runWrangler(["secret", "put", "RUNNER_SETUP_VALIDATION_TOKEN"], account, {
    input: `${setupToken}\n`,
    quiet: true,
  });
  try {
    const response = await authorizedWorkerRequest(`${baseUrl}/v1/setup/cloudflare-token`, setupToken);
    if (response.status === 404) {
      return { manual: true };
    }
    if (!response.ok) {
      throw new Error(`Could not inspect the runner's Cloudflare Containers token (status ${response.status})`);
    }
    const result = z
      .object({ token: z.object({ id: z.string().length(32), status: z.string() }).nullish() })
      .parse(await response.json());
    return result.token === undefined || result.token === null ? undefined : { manual: false, ...result.token };
  } finally {
    try {
      await runWrangler(["secret", "delete", "RUNNER_SETUP_VALIDATION_TOKEN"], account, {
        input: "y\n",
        quiet: true,
      });
    } catch {
      console.error("Warning: could not remove the temporary Worker teardown credential");
    }
  }
}

async function manuallyRemoveCloudflareContainersToken(account) {
  const settingsUrl = cloudflareAccountTokenSettingsUrl(account.account.id);
  console.log(
    `\nOpen ${settingsUrl} and delete the account API token named "Cloudflare GitHub Actions Runner" if setup created it.`,
  );
  openExternalUrl(settingsUrl);
  const removed = await confirm({
    message: "I deleted the dedicated token, or setup reused a token that I intentionally want to keep",
    default: false,
  });
  if (!removed) {
    throw new Error("Cloudflare teardown stopped before deleting the runner resources");
  }
}

async function removeCloudflareContainersToken(account, wranglerToken, identity) {
  if (identity === undefined) {
    return;
  }
  if (identity.manual === true) {
    await manuallyRemoveCloudflareContainersToken(account);
    return;
  }
  try {
    await cloudflareApiRequest(wranglerToken, account.account.id, `/tokens/${encodeURIComponent(identity.id)}`, {
      method: "DELETE",
    });
    console.log(`  ✔ Deleted account-owned Cloudflare Containers token ${identity.id}`);
  } catch (error) {
    console.log(`Cloudflare could not automatically delete account token ${identity.id}: ${String(error)}`);
    await manuallyRemoveCloudflareContainersToken(account);
  }
}

async function teardownGitHub(account, token, workerName, githubOwner, expectedAppId) {
  const setupToken = randomBytes(32).toString("hex");
  const baseUrl = await workerBaseUrl(token, account.account.id, workerName);
  await runWrangler(["secret", "put", "RUNNER_SETUP_VALIDATION_TOKEN"], account, {
    input: `${setupToken}\n`,
    quiet: true,
  });
  let removedCredentials = false;
  try {
    const status = await workerGitHubAppStatus(baseUrl, setupToken);
    if (!status.configured) {
      console.log("No GitHub App credentials are configured in the Worker.");
      await deleteWorkerSecrets(account, [...githubSecretNames, "RUNNER_SETUP_VALIDATION_TOKEN"]);
      removedCredentials = true;
      return;
    }
    if (!status.valid) {
      throw new Error(
        "The stored GitHub App credentials are invalid. Delete the App manually in GitHub before deleting Cloudflare, so its identity is not lost.",
      );
    }
    if (status.id !== expectedAppId) {
      throw new Error(
        `The configured GitHub App ID changed from ${expectedAppId} to ${status.id ?? "unknown"}. Nothing was deleted.`,
      );
    }
    assertGitHubTeardownOwner(status, githubOwner);

    console.log(`\nGitHub App: ${status.slug ?? "unknown"}`);
    console.log(`GitHub App owner: ${status.owner?.login ?? "unknown"}`);
    console.log(
      `GitHub App installations: ${status.installations.length === 0 ? "none" : status.installations.map(({ account: installationAccount }) => installationAccount).join(", ")}`,
    );
    const removal = await authorizedWorkerRequest(`${baseUrl}/v1/setup/github-app/installations`, setupToken, {
      method: "DELETE",
    });
    if (!removal.ok && removal.status !== 404) {
      throw new Error(`Could not remove the runner GitHub App installations (status ${removal.status})`);
    }
    if (removal.ok) {
      const result = z.object({ removed: z.array(z.object({ account: z.string() })) }).parse(await removal.json());
      for (const installation of result.removed) {
        console.log(`  ✔ Removed GitHub App installation from ${installation.account}`);
      }
    } else {
      console.log(
        "This deployed Worker predates automatic App uninstallation; deleting the App below removes its installations.",
      );
    }

    const settingsUrl = githubAppSettingsUrl(status);
    if (settingsUrl === undefined) {
      throw new Error("GitHub did not return enough information to locate the App settings page");
    }
    console.log(
      `\nGitHub requires the App owner to delete the App registration in settings.\n` +
        `Open ${settingsUrl}, scroll to the danger zone, and delete the App.`,
    );
    openExternalUrl(settingsUrl);
    const deleted = await confirm({ message: "I deleted the GitHub App registration", default: false });
    if (!deleted) {
      throw new Error(
        "GitHub teardown stopped. The Cloudflare resources remain so you can finish deleting the App safely.",
      );
    }
    await deleteWorkerSecrets(account, [...githubSecretNames, "RUNNER_SETUP_VALIDATION_TOKEN"]);
    removedCredentials = true;
    console.log("✔ GitHub App credentials removed from the Worker");
  } finally {
    if (!removedCredentials) {
      try {
        await runWrangler(["secret", "delete", "RUNNER_SETUP_VALIDATION_TOKEN"], account, {
          input: "y\n",
          quiet: true,
        });
      } catch {
        console.error("Warning: could not remove the temporary Worker teardown credential");
      }
    }
  }
}

export function encodeR2ObjectKey(key) {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function deleteR2Prefix(token, accountId, bucketName, prefix) {
  let deleted = 0;
  for (;;) {
    const query = new URLSearchParams({ per_page: "1000", prefix });
    // eslint-disable-next-line no-await-in-loop -- deleting the first page keeps cursor pagination stable.
    const page = await cloudflareApiRequest(
      token,
      accountId,
      `/r2/buckets/${encodeURIComponent(bucketName)}/objects?${query}`,
    );
    const objects = z.array(z.object({ key: nonEmptyStringSchema })).parse(page.result);
    if (objects.length === 0) {
      return deleted;
    }
    for (let offset = 0; offset < objects.length; offset += r2ObjectDeleteConcurrency) {
      const chunk = objects.slice(offset, offset + r2ObjectDeleteConcurrency);
      // eslint-disable-next-line no-await-in-loop -- bound concurrent destructive requests to one small batch.
      await Promise.all(
        chunk.map(({ key }) =>
          cloudflareApiRequest(
            token,
            accountId,
            `/r2/buckets/${encodeURIComponent(bucketName)}/objects/${encodeR2ObjectKey(key)}`,
            { method: "DELETE" },
          ),
        ),
      );
      deleted += chunk.length;
    }
  }
}

async function deleteOwnedR2Objects(token, accountId, bucketName, prefixes) {
  let deleted = 0;
  for (const prefix of prefixes) {
    // eslint-disable-next-line no-await-in-loop -- ownership prefixes are deliberately cleaned one at a time.
    deleted += await deleteR2Prefix(token, accountId, bucketName, prefix);
  }
  return deleted;
}

export function cloudflareDeletionOperations(inventory) {
  return [
    ...inventory.workflows.map(({ name }) => ({ kind: "workflow", target: name })),
    ...(inventory.worker === undefined ? [] : [{ kind: "worker", target: inventory.worker }]),
    ...inventory.applications.map(({ id, name }) => ({ kind: "application", target: id, label: name })),
    ...inventory.images.map((image) => ({ kind: "image", target: image })),
    ...inventory.buckets.map(({ name }) => ({ kind: "bucket", target: name })),
    ...inventory.databases.map(({ name }) => ({ kind: "database", target: name })),
  ];
}

export function cloudflareResourceIsAlreadyAbsent(error) {
  return (
    error instanceof TeardownCommandError &&
    /(?:not found|does not exist|could not find|\b404\b|code:\s*1009[02])/iu.test(error.output)
  );
}

async function deleteCloudflareOperation(account, token, operation) {
  if (operation.kind === "workflow") {
    await runWrangler(["workflows", "delete", operation.name], account, { quiet: true });
  } else if (operation.kind === "worker") {
    await runWrangler(["delete", operation.id, "--force"], account, { quiet: true });
  } else if (operation.kind === "application") {
    await runWrangler(["containers", "delete", operation.id], account, { quiet: true });
  } else if (operation.kind === "image") {
    await runWrangler(["containers", "images", "delete", operation.id, "--skip-confirmation"], account, {
      quiet: true,
    });
  } else if (operation.kind === "bucket" || operation.kind === "bucket-prefixes") {
    const deleted = await deleteOwnedR2Objects(token, account.account.id, operation.id, operation.prefixes);
    if (operation.kind === "bucket") {
      await cloudflareApiRequest(token, account.account.id, `/r2/buckets/${encodeURIComponent(operation.id)}`, {
        method: "DELETE",
      });
      console.log(`  ✔ Deleted R2 bucket ${operation.id} (${deleted.toLocaleString()} managed objects)`);
    } else {
      console.log(
        `  ✔ Deleted ${deleted.toLocaleString()} managed objects from R2 bucket ${operation.id}; kept the bucket and ${operation.unknownObjects.toLocaleString()} unowned objects`,
      );
    }
    return;
  } else if (operation.kind === "database") {
    await runWrangler(["d1", "delete", operation.id, "--skip-confirmation"], account, { quiet: true });
  }
  console.log(`  ✔ Deleted ${operation.kind} ${operation.name}`);
}

async function teardownCloudflare(account, token, operations) {
  for (const operation of operations) {
    if (operation.kind === "cloudflare-token" || operation.kind === "github-app") continue;
    try {
      // eslint-disable-next-line no-await-in-loop -- shutdown and storage deletion must remain deliberately ordered.
      await deleteCloudflareOperation(account, token, operation);
    } catch (error) {
      if (!cloudflareResourceIsAlreadyAbsent(error)) {
        throw error;
      }
      console.log(`  ✔ ${operation.kind} ${operation.name} was already removed`);
    }
  }
}

export async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Teardown is interactive and must be run in a terminal");
  }
  console.log("Cloudflare GitHub Actions runner teardown\n");
  const scopes = await promptForTeardownScopes();
  if (!scopes.cloudflare && !scopes.github) {
    console.log("Nothing selected. Teardown stopped.");
    return;
  }

  const accounts = await cloudflareAccounts();
  if (accounts.length === 0) {
    throw new Error("No authenticated Wrangler profiles contain an available Cloudflare account");
  }
  const account = await select({
    message: "Which Cloudflare account contains the runner pool?",
    choices: accounts.map((candidate) => ({
      name: `${candidate.account.name} (${candidate.account.id}) — Wrangler profile: ${candidate.profile}`,
      value: candidate,
    })),
  });
  const token = await cloudflareProfileToken(account.profile);
  const config = parseTeardownConfig(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  const inventory = await inspectCloudflareResources(config, account, token);
  if (scopes.github && inventory.worker === undefined) {
    throw new Error(
      "The runner Worker was not found. Its GitHub App credentials are unavailable, so delete the App in GitHub before cleaning up remaining Cloudflare resources.",
    );
  }
  let githubOwner;
  if (scopes.github) {
    const owners = await githubAccounts();
    if (owners.length === 0) {
      throw new Error("GitHub CLI did not return a personal account or an organization you administer");
    }
    githubOwner = await promptForGitHubTeardownOwner(
      owners,
      inventory.ownershipManifest?.githubOwner ?? inventory.githubOwner,
    );
    if (inventory.githubOwner !== undefined) {
      assertGitHubTeardownOwner({ owner: { login: inventory.githubOwner } }, githubOwner);
    }
  }
  const manifest = inventory.ownershipManifest;
  let taggedResources = [];
  let bucketOwnership;
  if (manifest !== undefined) {
    [taggedResources, bucketOwnership] = await Promise.all([
      inspectWorkerRunnerOwnership(account, token, config.name, manifest.installationId),
      inventory.buckets.some(({ name }) => name === manifest.bucket.name)
        ? inspectR2BucketOwnership(token, account.account.id, manifest.bucket)
        : undefined,
    ]);
  }
  const planned = buildOwnedTeardownPlan(manifest, {
    accountId: account.account.id,
    githubOwner: githubOwner?.login ?? manifest?.githubOwner,
    taggedResources,
    worker: inventory.worker === undefined ? undefined : { name: inventory.worker },
    applications: inventory.applications,
    workflows: inventory.workflows,
    databases: inventory.databases,
    bucket: bucketOwnership,
    images: inventory.images,
  });
  if (planned.blocked.length > 0) {
    console.log("\nTeardown is blocked; no destructive plan was produced:");
    for (const reason of planned.blocked) console.log(`  ✘ ${reason}`);
    console.log("\nRun setup and explicitly adopt this existing pool before attempting teardown.");
    return;
  }
  const operations = planned.operations.filter((operation) =>
    operation.kind === "github-app"
      ? scopes.github
      : operation.kind === "cloudflare-token"
        ? scopes.cloudflare
        : scopes.cloudflare,
  );
  console.log(`\nVerified runner installation: ${manifest.installationId}`);
  console.log("The following ownership-verified resources will be deleted:");
  if (operations.length === 0) console.log("  none");
  for (const operation of operations) {
    const qualifier =
      operation.kind === "bucket-prefixes"
        ? ` (managed prefixes only; preserving ${operation.unknownObjects} unowned objects)`
        : "";
    console.log(`  ${operation.kind}: ${operation.name}${qualifier}`);
  }
  if (operations.length === 0) {
    console.log("\nNothing to delete. Teardown complete.");
    return;
  }

  let githubStatus;
  const githubAppOperation = operations.find(({ kind }) => kind === "github-app");
  if (githubAppOperation !== undefined) {
    githubStatus = await inspectGitHubApp(account, token, config.name);
    if (!githubStatus.configured || !githubStatus.valid || String(githubStatus.id) !== githubAppOperation.id) {
      throw new Error(
        "The protected GitHub App identity no longer matches the ownership manifest. Nothing was deleted.",
      );
    }
    assertGitHubTeardownOwner(githubStatus, githubOwner);
  }
  let containersToken;
  const tokenOperation = operations.find(({ kind }) => kind === "cloudflare-token");
  if (tokenOperation !== undefined) {
    containersToken = await inspectCloudflareContainersToken(account, token, config.name);
    if (containersToken?.manual !== false || containersToken.id !== tokenOperation.id) {
      throw new Error(
        "The protected Cloudflare Containers token identity no longer matches the ownership manifest. Nothing was deleted.",
      );
    }
  }
  const confirmed = await promptForTeardownConfirmation();
  if (!confirmed) {
    console.log("Teardown stopped. Nothing was deleted.");
    return;
  }

  if (githubAppOperation !== undefined) {
    await teardownGitHub(account, token, config.name, githubOwner, Number(githubAppOperation.id));
  }
  if (scopes.cloudflare) {
    if (containersToken !== undefined) await removeCloudflareContainersToken(account, token, containersToken);
    await teardownCloudflare(account, token, operations);
  }
  console.log("\nTeardown complete.");
}
