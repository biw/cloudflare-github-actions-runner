// @ts-nocheck

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { confirm, input, password, select } from "@inquirer/prompts";
import { z } from "zod";

import { newRunnerInstallationId, parseRunnerOwnershipManifest } from "./resource-ownership";

export interface GitHubRunnerOwner {
  type: "personal" | "organization";
  login: string;
  name?: string;
}

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const githubCommand = process.platform === "win32" ? "gh.exe" : "gh";
const githubApiVersion = "2022-11-28";
const terminalColor = {
  green: "\u001b[32m",
  red: "\u001b[31m",
  reset: "\u001b[0m",
};
const superAdministratorRole = "Super Administrator - All Privileges";
const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const workerTokenValidationAttempts = 30;
const workerTokenValidationRetryDelayMs = 1_000;
const workerHealthCheckAttempts = 60;
const workerHealthCheckRetryDelayMs = 1_000;
const deploymentProgressPrefix = "CLOUDFLARE_RUNNER_SETUP_PHASE:";
const runnerWorkerName = "cloudflare-github-actions-runner";
const runnerImageBuildWorkflowName = "cloudflare-github-actions-runner-image-build";
export const defaultRunnerCacheBucketName = "cloudflare-github-actions-runner-cache";
export const defaultRunnerCacheMaximumGigabytes = 100;

const nonEmptyStringSchema = z.string().trim().min(1);
const optionalStringSchema = z.string().optional().catch(undefined);
const workerBindingSchema = z.object({
  name: z.string(),
  text: z.string().optional().catch(undefined),
  value: z.string().optional().catch(undefined),
});
const workerSettingsSchema = z.object({ bindings: z.array(z.json()).optional().catch([]) });

function colorStatus(color, status) {
  return `${terminalColor[color]}${status}${terminalColor.reset}`;
}

export function formatSetupStepDuration(durationMs) {
  const roundedDurationMs = Math.max(0, Math.round(durationMs));
  if (roundedDurationMs < 1_000) {
    return `${roundedDurationMs}ms`;
  }
  if (roundedDurationMs < 60_000) {
    return `${(roundedDurationMs / 1_000).toFixed(1)}s`;
  }
  const minutes = Math.floor(roundedDurationMs / 60_000);
  const seconds = Math.floor((roundedDurationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

async function withSpinner(checkingStatus, completeStatus, operation) {
  let frame = 0;
  let timer;
  let currentCheckingStatus = checkingStatus;
  const render = () => {
    process.stdout.write(`\r\u001b[2K${spinnerFrames[frame]} ${currentCheckingStatus}...`);
    frame = (frame + 1) % spinnerFrames.length;
  };
  const pause = () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    process.stdout.write("\r\u001b[2K");
  };
  const resume = () => {
    if (timer !== undefined) {
      return;
    }
    render();
    timer = setInterval(render, 80);
    timer.unref();
  };
  const updateStatus = (status) => {
    currentCheckingStatus = status;
    if (timer !== undefined) {
      render();
    }
  };
  const runStep = async (status, completedStatus, step) => {
    updateStatus(status);
    const startedAt = Date.now();
    const result = await step();
    pause();
    process.stdout.write(
      `${colorStatus("green", `✔ ${completedStatus} (${formatSetupStepDuration(Date.now() - startedAt)})`)}\n`,
    );
    resume();
    return result;
  };

  resume();
  try {
    const result = await operation({ pause, resume, runStep, updateStatus });
    pause();
    const status = completeStatus instanceof Function ? completeStatus(result) : { message: completeStatus };
    process.stdout.write(`${colorStatus(status.color ?? "green", `${status.marker ?? "✔"} ${status.message}`)}\n`);
    return result;
  } catch (error) {
    pause();
    process.stdout.write(`${colorStatus("red", `✘ ${checkingStatus}: failed`)}\n`);
    throw error;
  }
}

function printCloudflareAccountStatus(account, { containersEnabled, superAdministrator, superAdministratorVerified }) {
  console.log(`     Account ID: ${account.id}`);
  console.log(
    `     ${colorStatus(
      containersEnabled ? "green" : "red",
      `${containersEnabled ? "\u2714" : "\u2718"} Workers Paid + Containers: ${containersEnabled ? "enabled" : "unavailable"}`,
    )}`,
  );
  const superAdministratorStatus = superAdministrator
    ? "Super Administrator"
    : superAdministratorVerified
      ? "Super Administrator required"
      : "unable to verify Super Administrator";
  console.log(
    `     ${colorStatus(
      superAdministrator ? "green" : "red",
      `${superAdministrator ? "\u2714" : "\u2718"} User role: ${superAdministratorStatus}`,
    )}`,
  );
}

export function runnerPoolSummary(runnerPool) {
  if (!runnerPool.workerFound) {
    return "GitHub App not configured";
  }
  if (runnerPool.githubAppConfigured) {
    return "GitHub App configured";
  }
  return runnerPool.legacyPatConfigured ? "GitHub App needs migration from legacy PAT setup" : "GitHub App needs setup";
}

function printRunnerPoolStatus(runnerPool) {
  const configured = runnerPool.workerFound && runnerPool.githubAppConfigured;
  console.log(
    `     ${colorStatus(configured ? "green" : "red", `${configured ? "✔" : "✘"} ${runnerPoolSummary(runnerPool)}`)}`,
  );
}

export function generateWebhookSecret() {
  return randomBytes(32).toString("hex");
}

export function generateResourceTraceSigningKey() {
  return randomBytes(32).toString("base64url");
}

export function validRunnerCacheBucketName(value) {
  return /^(?=.{3,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(value);
}

export function validRunnerCacheMaximumGigabytes(value) {
  const gigabytes = Number(value);
  return Number.isSafeInteger(gigabytes) && gigabytes > 0 && Number.isSafeInteger(gigabytes * 1_000_000_000);
}

export async function promptForRunnerCacheConfiguration(prompts = { confirm, input }) {
  const enabled = await prompts.confirm({
    message: "Store GitHub Actions dependency caches in Cloudflare R2?",
    default: true,
  });
  const bucketName = await prompts.input({
    message: "Private R2 runner storage bucket name",
    default: defaultRunnerCacheBucketName,
    validate: (value) =>
      validRunnerCacheBucketName(value) ||
      "Use 3–63 lowercase letters, numbers, and hyphens; it must begin and end with a letter or number",
  });
  if (!enabled) {
    return { RUNNER_CACHE_ENABLED: "false", RUNNER_CACHE_BUCKET_NAME: bucketName };
  }
  const maximumGigabytes = await prompts.input({
    message: "Maximum R2 cache size (GB; FIFO eviction)",
    default: String(defaultRunnerCacheMaximumGigabytes),
    validate: (value) => validRunnerCacheMaximumGigabytes(value) || "Enter a positive whole number of GB",
  });
  return {
    RUNNER_CACHE_ENABLED: "true",
    RUNNER_CACHE_BUCKET_NAME: bucketName,
    RUNNER_CACHE_MAX_SIZE_GB: maximumGigabytes,
  };
}

export function githubRunnerTokenSecretName(owner) {
  return `GITHUB_RUNNER_TOKEN_${createHash("sha256").update(owner.trim().toLowerCase()).digest("hex")}`;
}

export function parseWorkerSecretNames(value) {
  let secrets;
  try {
    secrets = JSON.parse(value);
  } catch {
    throw new Error("Wrangler returned invalid Worker secret information");
  }
  const parsedSecrets = z.array(z.json()).safeParse(secrets);
  if (!parsedSecrets.success) {
    throw new Error("Wrangler returned invalid Worker secret information");
  }
  return new Set(
    parsedSecrets.data.flatMap((secret) => {
      const parsed = z.object({ name: nonEmptyStringSchema }).safeParse(secret);
      return parsed.success ? [parsed.data.name] : [];
    }),
  );
}

export function inspectRunnerPoolSecrets(secretNames) {
  const githubAppConfigured =
    secretNames.has("GITHUB_APP_ID") &&
    secretNames.has("GITHUB_APP_PRIVATE_KEY") &&
    secretNames.has("GITHUB_APP_WEBHOOK_SECRET");
  return {
    configured:
      secretNames.has("CLOUDFLARE_CONTAINERS_API_TOKEN") &&
      secretNames.has("RESOURCE_TRACE_SIGNING_KEY") &&
      secretNames.has("RUNNER_CACHE_SIGNING_KEY") &&
      githubAppConfigured,
    githubAppConfigured,
    githubRunnerOwnerSecretConfigured: secretNames.has("GITHUB_RUNNER_OWNER"),
    legacyPatConfigured:
      secretNames.has("GITHUB_RUNNER_TOKEN") || [...secretNames].some((name) => /^GITHUB_RUNNER_TOKEN_/u.test(name)),
  };
}

export function readLegacyRepositorySettings(configText) {
  const valueFor = (name) => {
    const match = configText.match(new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`));
    return match?.[1];
  };

  const owner = valueFor("LEGACY_GITHUB_OWNER") ?? valueFor("GITHUB_OWNER");
  const repository = valueFor("LEGACY_GITHUB_REPOSITORY") ?? valueFor("GITHUB_REPOSITORY");
  if (owner === undefined || repository === undefined) {
    throw new Error("wrangler.jsonc must define LEGACY_GITHUB_OWNER and LEGACY_GITHUB_REPOSITORY");
  }

  return { owner, repository };
}

export const readRepositorySettings = readLegacyRepositorySettings;

export function readCustomRunnerApplication(configText) {
  const match = configText.match(/"CUSTOM_RUNNER_APPLICATION"\s*:\s*"([^"]+)"/u);
  if (match?.[1] === undefined) {
    throw new Error("wrangler.jsonc must define CUSTOM_RUNNER_APPLICATION");
  }
  return match[1];
}

export function parseCloudflareIdentity(identityText) {
  let identity;
  try {
    identity = JSON.parse(identityText);
  } catch {
    throw new Error("Wrangler returned invalid Cloudflare account information");
  }

  const parsedIdentity = z
    .object({ loggedIn: z.literal(true), email: optionalStringSchema, accounts: z.array(z.json()) })
    .safeParse(identity);
  if (!parsedIdentity.success) {
    throw new Error("Wrangler is not authenticated with Cloudflare");
  }

  const accounts = parsedIdentity.data.accounts.flatMap((account) => {
    const parsed = z.object({ id: z.string(), name: z.string() }).safeParse(account);
    return parsed.success ? [parsed.data] : [];
  });
  if (accounts.length === 0) {
    throw new Error("The Cloudflare login does not have access to an account");
  }

  return { email: parsedIdentity.data.email, accounts };
}

export function parseCloudflareAccounts(identityText) {
  return parseCloudflareIdentity(identityText).accounts;
}

export function hasSuperAdministratorRole(membershipText) {
  return membershipText.split(/\r?\n/u).some((line) => line.trim() === `- ${superAdministratorRole}`);
}

export function cloudflareContainersTokenTemplateUrl() {
  const url = new URL("https://dash.cloudflare.com/");
  url.searchParams.set("to", "/:account/api-tokens");
  url.searchParams.set(
    "permissionGroupKeys",
    JSON.stringify([
      { key: "containers", type: "edit" },
      { key: "tag", type: "read" },
      { key: "tag", type: "edit" },
    ]),
  );
  url.searchParams.set("name", "Cloudflare GitHub Actions Runner");
  return url.toString();
}

export function parseRunnerSetupTokenStatus(value) {
  let status;
  try {
    status = JSON.parse(value);
  } catch {
    throw new Error("Worker returned invalid token validation information");
  }

  const parsedStatus = z
    .object({
      cloudflareContainersToken: z.boolean(),
      cloudflareRegistryPush: z.boolean(),
      cloudflareResourceTagging: z.boolean(),
      githubApp: z.boolean(),
      githubAppWebhookSecret: z.boolean(),
      resourceTraceSigningKey: z.boolean(),
      runnerCacheSigningKey: z.boolean(),
    })
    .safeParse(status);
  if (!parsedStatus.success) {
    throw new Error("Worker returned incomplete token validation information");
  }
  return parsedStatus.data;
}

export function hasValidRunnerSetupTokenStatus(status) {
  return (
    status.cloudflareContainersToken &&
    status.cloudflareRegistryPush &&
    status.cloudflareResourceTagging &&
    status.githubApp &&
    status.githubAppWebhookSecret &&
    status.resourceTraceSigningKey &&
    status.runnerCacheSigningKey
  );
}

/** Non-sensitive credential check results shown before setup changes any stored credentials. */
export function existingWorkerTokenStatusMessages(status) {
  const cloudflareTokenValid =
    status.cloudflareContainersToken && status.cloudflareRegistryPush && status.cloudflareResourceTagging;
  const githubAppValid = status.githubApp && status.githubAppWebhookSecret;
  return [
    `${cloudflareTokenValid ? "✔" : "✘"} Cloudflare Containers Write + Tag Read/Write token: ${cloudflareTokenValid ? "valid (reusing)" : "needs attention"}`,
    `${githubAppValid ? "✔" : "✘"} GitHub App credentials: ${githubAppValid ? "valid (reusing)" : "unavailable or rejected"}`,
    `${status.resourceTraceSigningKey ? "✔" : "✘"} Runner resource-trace signing key: ${status.resourceTraceSigningKey ? "present (reusing)" : "missing"}`,
    `${status.runnerCacheSigningKey ? "✔" : "✘"} Runner R2-cache signing key: ${status.runnerCacheSigningKey ? "present (reusing)" : "missing"}`,
  ];
}

/** Keep discoverable App credentials until the user explicitly chooses a replacement. */
export function shouldCreateInitialGitHubApp(existingTokens, existingGitHubAppConfiguration) {
  return !(existingTokens.githubApp && existingTokens.githubAppWebhookSecret) && !existingGitHubAppConfiguration;
}

export function githubAppManifest(name, workerBaseUrl, redirectUrl) {
  return {
    name,
    description: "Runs GitHub Actions jobs in disposable Cloudflare Containers.",
    url: workerBaseUrl,
    hook_attributes: { url: `${workerBaseUrl}/webhooks/github`, active: true },
    redirect_url: redirectUrl,
    public: true,
    default_permissions: {
      actions: "read",
      administration: "write",
      checks: "write",
      contents: "read",
    },
    default_events: ["workflow_job", "push"],
  };
}

export function githubAppSetupSummary(appSlug) {
  return `GitHub App: ${nonEmptyStringSchema.parse(appSlug)}`;
}

export function parseGitHubAppManifestConversion(value) {
  let result;
  try {
    result = JSON.parse(value);
  } catch {
    throw new Error("GitHub returned invalid GitHub App registration information");
  }
  const parsedResult = z
    .object({
      id: z.number().int().positive(),
      pem: nonEmptyStringSchema,
      webhook_secret: nonEmptyStringSchema,
      slug: nonEmptyStringSchema,
    })
    .safeParse(result);
  if (!parsedResult.success) {
    throw new Error("GitHub returned incomplete GitHub App registration information");
  }
  return {
    id: String(parsedResult.data.id),
    privateKey: parsedResult.data.pem,
    webhookSecret: parsedResult.data.webhook_secret,
    slug: parsedResult.data.slug,
  };
}

export function extractWorkerBaseUrl(output) {
  return output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/iu)?.[0];
}

export function normalizeWorkerBaseUrl(value) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
      return undefined;
    }
    url.pathname = url.pathname.replace(/\/+$/u, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return undefined;
  }
}

export class WorkerTokenValidationError extends Error {
  constructor(status) {
    super(`Worker token validation failed with status ${status}`);
    this.status = status;
  }
}

export class WorkerHealthCheckError extends Error {
  constructor(status, workerBaseUrl) {
    super(
      `Worker health check failed with ${status === undefined ? "a network error" : `status ${status}`} at ${workerBaseUrl}`,
    );
    this.status = status;
  }
}

function retryableWorkerHealthCheckError(error) {
  return (
    error instanceof WorkerHealthCheckError &&
    (error.status === undefined || error.status === 404 || (error.status >= 500 && error.status <= 599))
  );
}

export async function waitForWorkerHealthCheck(check, options = {}) {
  const { attempts = workerHealthCheckAttempts, retryDelayMs = workerHealthCheckRetryDelayMs } = options;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- each probe must finish before deciding whether to retry.
      return await check();
    } catch (error) {
      if (!retryableWorkerHealthCheckError(error) || attempt === attempts) {
        throw error;
      }
    }
    // eslint-disable-next-line no-await-in-loop -- workers.dev availability can briefly lag a successful deploy.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, retryDelayMs));
  }
  throw new Error("Worker health check did not run");
}

export async function waitForWorkerTokenValidation(validate, options = {}) {
  const {
    attempts = workerTokenValidationAttempts,
    retryDelayMs = workerTokenValidationRetryDelayMs,
    isValid = () => true,
  } = options;
  const validateAttempt = async (attempt) => {
    try {
      const status = await validate();
      if (isValid(status) || attempt === attempts) {
        return status;
      }
    } catch (error) {
      if (!(error instanceof WorkerTokenValidationError) || error.status !== 401 || attempt === attempts) {
        throw error;
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, retryDelayMs));
    return validateAttempt(attempt + 1);
  };
  return validateAttempt(1);
}

export async function retryWorkerTokenValidation(validate, options = {}) {
  return waitForWorkerTokenValidation(validate, options);
}

/**
 * A successful secret update can briefly leave workers.dev serving both the
 * previous and current Worker versions. Retry setup-only requests which land
 * on a version that does not yet have this setup run's temporary credential.
 */
export async function waitForWorkerSetupAuthorization(request, options = {}) {
  const {
    attempts = workerTokenValidationAttempts,
    retryDelayMs = workerTokenValidationRetryDelayMs,
    retryStatuses = [401],
  } = options;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- each response determines whether propagation has completed.
    const response = await request();
    if (!retryStatuses.includes(response.status) || attempt === attempts) {
      return response;
    }
    // eslint-disable-next-line no-await-in-loop -- workers.dev can briefly route to the previous secret version.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, retryDelayMs));
  }
  throw new Error("Worker setup authorization check did not run");
}

function runCommand(command, args, options = {}) {
  const { environment = {}, input: commandInput, quiet = false, interactive = false, onOutput } = options;

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: { ...process.env, ...environment },
      stdio: interactive ? "inherit" : ["pipe", "pipe", "pipe"],
    });

    if (interactive) {
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) {
          resolvePromise({ stdout: "", stderr: "" });
        } else {
          reject(new Error(`${command} ${args.join(" ")} exited with status ${code ?? "unknown"}`));
        }
      });
      return;
    }

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const value = chunk.toString();
      stdout += value;
      onOutput?.("stdout", value);
      if (!quiet) {
        process.stdout.write(value);
      }
    });
    child.stderr.on("data", (chunk) => {
      const value = chunk.toString();
      stderr += value;
      onOutput?.("stderr", value);
      if (!quiet) {
        process.stderr.write(value);
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        const output = stderr.trim() || stdout.trim();
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with status ${code ?? "unknown"}${output === "" ? "" : `:\n${output}`}`,
          ),
        );
      }
    });

    child.stdin.end(commandInput);
  });
}

export function deploymentProgressFromOutput(line) {
  const message = line.startsWith(deploymentProgressPrefix) ? line.slice(deploymentProgressPrefix.length).trim() : "";
  return message === "" ? undefined : message;
}

function deploymentProgressReporter(updateStatus) {
  let output = "";
  return (stream, chunk) => {
    if (stream !== "stdout") {
      return;
    }
    output += chunk;
    for (let lineEnd = output.indexOf("\n"); lineEnd >= 0; lineEnd = output.indexOf("\n")) {
      const line = output.slice(0, lineEnd).replace(/\r$/u, "");
      output = output.slice(lineEnd + 1);
      const progress = deploymentProgressFromOutput(line);
      if (progress !== undefined) {
        updateStatus(progress);
      }
    }
  };
}

function openExternalUrl(url) {
  const command =
    process.platform === "darwin"
      ? { command: "open", args: [url] }
      : process.platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url] }
        : { command: "xdg-open", args: [url] };
  const child = spawn(command.command, command.args, { detached: true, stdio: "ignore" });
  child.once("error", () => {
    console.log(`Could not open a browser automatically. Open this URL instead:\n${url}\n`);
  });
  child.unref();
}

function htmlDocumentForGitHubAppManifest(manifest, state, owner) {
  const action = `${githubAppManifestRegistrationUrl(owner)}?state=${encodeURIComponent(state)}`;
  const value = JSON.stringify(manifest).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  return `<!doctype html><title>Create GitHub App</title><form id="github-app-manifest" method="post" action="${action}"><input type="hidden" name="manifest" value="${value}"></form><script>document.getElementById("github-app-manifest").submit()</script>`;
}

function listenOnLoopback(server) {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = z.object({ port: z.number() }).safeParse(server.address());
      if (!address.success) {
        reject(new Error("Could not start the local GitHub App setup listener"));
        return;
      }
      resolvePromise(address.data.port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

export async function createGitHubAppFromManifest(name, workerBaseUrl, options = {}) {
  const { owner, open = openExternalUrl, fetchImplementation = fetch, timeoutMs = 10 * 60 * 1_000 } = options;
  const state = randomBytes(32).toString("hex");
  let resolveCode;
  let rejectCode;
  let timeout;
  const code = new Promise((resolvePromise, reject) => {
    resolveCode = resolvePromise;
    rejectCode = reject;
  });
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && requestUrl.pathname === "/github-app/manifest") {
      const address = z.object({ port: z.number() }).safeParse(server.address());
      if (!address.success) {
        response.writeHead(500).end("GitHub App setup listener is unavailable");
        return;
      }
      const redirectUrl = `http://127.0.0.1:${address.data.port}/github-app/callback`;
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(htmlDocumentForGitHubAppManifest(githubAppManifest(name, workerBaseUrl, redirectUrl), state, owner));
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/github-app/callback") {
      if (requestUrl.searchParams.get("state") !== state || requestUrl.searchParams.get("code") === null) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("GitHub App setup could not be verified. Return to the terminal and try again.");
        rejectCode(new Error("GitHub App setup callback did not contain the expected state and code"));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("GitHub App created. Return to the terminal to complete setup.");
      resolveCode(requestUrl.searchParams.get("code"));
      return;
    }
    response.writeHead(404).end();
  });

  try {
    const port = await listenOnLoopback(server);
    const manifestUrl = `http://127.0.0.1:${port}/github-app/manifest`;
    console.log(
      `\nOpening GitHub to create the Cloudflare GitHub Actions App${owner === undefined ? "" : ` for ${owner.login}`}: ${manifestUrl}`,
    );
    open(manifestUrl);
    const manifestCode = await Promise.race([
      code,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("GitHub App creation timed out")), timeoutMs);
      }),
    ]);
    const response = await fetchImplementation(
      `https://api.github.com/app-manifests/${encodeURIComponent(manifestCode)}/conversions`,
      {
        method: "POST",
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": githubApiVersion },
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub App registration failed with status ${response.status}`);
    }
    return parseGitHubAppManifestConversion(await response.text());
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    await closeServer(server);
  }
}

async function cloudflareRequest(token, accountId, path) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/containers${path}`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
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

export function parseWranglerAuthProfiles(output) {
  const profiles = new Set();
  const escape = String.fromCodePoint(27);
  let plainOutput = output;
  for (let start = plainOutput.indexOf(`${escape}[`); start >= 0; start = plainOutput.indexOf(`${escape}[`)) {
    const end = plainOutput.indexOf("m", start);
    if (end < 0) {
      break;
    }
    plainOutput = `${plainOutput.slice(0, start)}${plainOutput.slice(end + 1)}`;
  }
  for (const line of plainOutput.split(/\r?\n/u)) {
    const match = line.match(/^\s*[│|]\s*([^│|]+?)\s*[│|]/u);
    const profile = match?.[1]?.trim();
    if (profile !== undefined && profile !== "" && profile !== "Profile" && !/^[-─]+$/u.test(profile)) {
      profiles.add(profile);
    }
  }
  return [...profiles].sort((left, right) => left.localeCompare(right));
}

function wranglerArguments(arguments_, profile) {
  return ["wrangler", ...arguments_, ...(profile === undefined ? [] : ["--profile", profile])];
}

async function cloudflareProfileToken(profile) {
  const result = await runCommand(npxCommand, wranglerArguments(["auth", "token", "--json"], profile), { quiet: true });
  let credential;
  try {
    credential = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Wrangler returned an invalid credential for profile ${profile}`);
  }
  const parsedCredential = z.object({ token: nonEmptyStringSchema }).safeParse(credential);
  if (!parsedCredential.success) {
    throw new Error(`Wrangler profile ${profile} does not contain a usable Cloudflare credential`);
  }
  return parsedCredential.data.token;
}

async function cloudflareIdentityForProfile(profile) {
  const token = await cloudflareProfileToken(profile);
  const result = await runCommand(npxCommand, ["wrangler", "whoami", "--json"], {
    environment: { CLOUDFLARE_API_TOKEN: token },
    quiet: true,
  });
  return parseCloudflareIdentity(result.stdout);
}

async function existingCloudflareProfiles() {
  const result = await runCommand(npxCommand, ["wrangler", "auth", "list"], { quiet: true });
  const profiles = parseWranglerAuthProfiles(`${result.stdout}\n${result.stderr}`);
  const identities = await Promise.all(
    profiles.map(async (profile) => {
      try {
        return { profile, identity: await cloudflareIdentityForProfile(profile) };
      } catch {
        return undefined;
      }
    }),
  );
  return identities.filter((identity) => identity !== undefined);
}

function newCloudflareProfileName(profiles) {
  const base = "cloudflare-github-actions-runner";
  for (let suffix = 1; ; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    if (!profiles.includes(candidate)) {
      return candidate;
    }
  }
}

async function signInToAnotherCloudflareAccount(existingProfiles) {
  const profile = newCloudflareProfileName(existingProfiles);
  console.log("\nOpening Cloudflare sign-in in your browser...\n");
  await runCommand(npxCommand, ["wrangler", "auth", "create", profile], { interactive: true });
  return { profile, identity: await cloudflareIdentityForProfile(profile) };
}

async function hasCloudflareContainersEligibility(cloudflareAccount, profile) {
  try {
    const result = await runCommand(npxCommand, wranglerArguments(["containers", "list", "--json"], profile), {
      environment: { CLOUDFLARE_ACCOUNT_ID: cloudflareAccount.id },
      quiet: true,
    });
    if (!Array.isArray(JSON.parse(result.stdout))) {
      throw new Error("Wrangler returned an unexpected Containers list");
    }
  } catch {
    return false;
  }

  return true;
}

async function getSuperAdministratorStatus(cloudflareAccount, profile) {
  try {
    const token = await cloudflareProfileToken(profile);
    // Wrangler emits membership roles only in its human-readable account view.
    const result = await runCommand(npxCommand, ["wrangler", "whoami", "--account", cloudflareAccount.id], {
      environment: { CLOUDFLARE_API_TOKEN: token },
      quiet: true,
    });
    return { superAdministrator: hasSuperAdministratorRole(`${result.stdout}\n${result.stderr}`), verified: true };
  } catch {
    return { superAdministrator: false, verified: false };
  }
}

export function githubRunnerOwnerFromWorkerSettings(settings) {
  const parsedSettings = workerSettingsSchema.safeParse(settings);
  const bindings = parsedSettings.success ? parsedSettings.data.bindings : [];
  // The functional owner is stored as a secret with the GitHub App
  // credentials. This non-secret mirror is only for setup's prompt default.
  // Accept the former public binding so an existing pool migrates cleanly.
  for (const name of ["RUNNER_POOL_GITHUB_OWNER", "GITHUB_RUNNER_OWNER"]) {
    const binding = bindings.flatMap((candidate) => {
      const parsed = workerBindingSchema.safeParse(candidate);
      return parsed.success && parsed.data.name === name ? [parsed.data] : [];
    })[0];
    const owner = nonEmptyStringSchema.safeParse(binding?.text ?? binding?.value);
    if (owner.success) {
      return owner.data;
    }
  }
  return undefined;
}

export function legacyGitHubOwnerFromWorkerSettings(settings) {
  const parsedSettings = workerSettingsSchema.safeParse(settings);
  const binding = parsedSettings.success
    ? parsedSettings.data.bindings.flatMap((candidate) => {
        const parsed = workerBindingSchema.safeParse(candidate);
        return parsed.success && parsed.data.name === "LEGACY_GITHUB_OWNER" ? [parsed.data] : [];
      })[0]
    : undefined;
  return nonEmptyStringSchema.safeParse(binding?.text ?? binding?.value).data;
}

async function configuredGitHubRunnerOwners(cloudflareAccount, profile) {
  try {
    const token = await cloudflareProfileToken(profile);
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cloudflareAccount.id)}/workers/scripts/${encodeURIComponent(runnerWorkerName)}/settings`,
      { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } },
    );
    if (response.status === 404) {
      return {};
    }
    const body = await response.json();
    if (!response.ok || body?.success !== true) {
      return {};
    }
    const githubRunnerOwner = githubRunnerOwnerFromWorkerSettings(body.result);
    const legacyGitHubOwner = legacyGitHubOwnerFromWorkerSettings(body.result);
    const ownershipManifest = parseRunnerOwnershipManifest(
      body.result?.bindings?.find(({ name }) => name === "RUNNER_RESOURCE_MANIFEST")?.text,
    );
    const result = {};
    if (githubRunnerOwner !== undefined) {
      result.githubRunnerOwner = githubRunnerOwner;
    }
    if (legacyGitHubOwner !== undefined) {
      result.legacyGitHubOwner = legacyGitHubOwner;
    }
    if (ownershipManifest !== undefined) {
      result.ownershipManifest = ownershipManifest;
      result.installationId = ownershipManifest.installationId;
    }
    return result;
  } catch {
    // This is only a prompt default. Setup remains usable if a credential
    // cannot read the Worker settings at this early inspection stage.
    return {};
  }
}

async function runnerPoolForCloudflareAccount(cloudflareAccount, profile) {
  try {
    const result = await runCommand(npxCommand, wranglerArguments(["secret", "list", "--format", "json"], profile), {
      environment: { CLOUDFLARE_ACCOUNT_ID: cloudflareAccount.id },
      quiet: true,
    });
    const runnerOwners = await configuredGitHubRunnerOwners(cloudflareAccount, profile);
    return {
      workerFound: true,
      ...inspectRunnerPoolSecrets(parseWorkerSecretNames(result.stdout)),
      ...runnerOwners,
    };
  } catch {
    return { workerFound: false, configured: false, githubAppConfigured: false, legacyPatConfigured: false };
  }
}

async function inspectCloudflareAccounts(cloudflareProfileIdentity) {
  const { profile, identity: cloudflareIdentity } = cloudflareProfileIdentity;
  const eligibility = await Promise.all(
    cloudflareIdentity.accounts.map(async (account) => {
      const [containersEnabled, superAdministratorStatus, runnerPool] = await Promise.all([
        hasCloudflareContainersEligibility(account, profile),
        getSuperAdministratorStatus(account, profile),
        runnerPoolForCloudflareAccount(account, profile),
      ]);
      return {
        account,
        profile,
        email: cloudflareIdentity.email,
        containersEnabled,
        superAdministrator: superAdministratorStatus.superAdministrator,
        superAdministratorVerified: superAdministratorStatus.verified,
        runnerPool,
      };
    }),
  );
  const eligibleAccounts = eligibility.filter(
    ({ containersEnabled, superAdministrator }) => containersEnabled && superAdministrator,
  );

  return { eligibility, eligibleAccounts };
}

function cloudflareAccountIsEligible(candidate) {
  return candidate.containersEnabled && candidate.superAdministrator;
}

function profilePreference(candidate, preferredProfile) {
  if (candidate.profile === preferredProfile) {
    return 0;
  }
  return candidate.profile === "default" ? 2 : 1;
}

/**
 * A Wrangler profile is a local credential, not a Cloudflare account. Show
 * each account once, preferring an explicitly selected profile or a named
 * profile over the generic `default` profile.
 */
export function collapseCloudflareAccountCandidates(candidates, preferredProfile = process.env.WRANGLER_PROFILE) {
  const byAccountId = new Map();
  for (const candidate of candidates) {
    const id = nonEmptyStringSchema.safeParse(candidate?.account?.id);
    if (!id.success) {
      continue;
    }
    const current = byAccountId.get(id.data);
    if (current === undefined) {
      byAccountId.set(id.data, candidate);
      continue;
    }
    const currentEligible = cloudflareAccountIsEligible(current);
    const candidateEligible = cloudflareAccountIsEligible(candidate);
    const preferCandidate =
      profilePreference(candidate, preferredProfile) < profilePreference(current, preferredProfile) ||
      (profilePreference(candidate, preferredProfile) === profilePreference(current, preferredProfile) &&
        candidate.profile.localeCompare(current.profile) < 0);
    if ((!currentEligible && candidateEligible) || (currentEligible === candidateEligible && preferCandidate)) {
      byAccountId.set(id.data, candidate);
    }
  }
  return [...byAccountId.values()].sort(
    (left, right) =>
      left.account.name.localeCompare(right.account.name) || left.account.id.localeCompare(right.account.id),
  );
}

function printCloudflareAccountCheck(eligibility) {
  for (const { account, email, profile, runnerPool, ...status } of eligibility) {
    console.log(`  User: ${email ?? "unknown"} - ${account.name} (Wrangler profile: ${profile})`);
    printCloudflareAccountStatus(account, status);
    printRunnerPoolStatus(runnerPool);
  }
}

function validateEligibleCloudflareAccounts(eligibleAccounts) {
  if (eligibleAccounts.length === 0) {
    throw new Error(
      "No available account has Workers Paid with Containers enabled and the signed-in user as a Super Administrator. Update the account plan or role, then run setup again.",
    );
  }
}

async function chooseEligibleCloudflareAccount(eligibleAccounts) {
  return select({
    message: "Which Cloudflare account will run and bill for this runner pool?",
    choices: [
      ...eligibleAccounts.map((candidate) => ({
        name: `${candidate.account.name} (${candidate.account.id}) — ${runnerPoolSummary(candidate.runnerPool)} — Wrangler profile: ${candidate.profile}`,
        value: candidate,
      })),
      { name: "Sign in to a different Cloudflare account", value: "sign-in" },
    ],
  });
}

async function chooseCloudflareAccount(existingProfiles, eligibleAccounts) {
  const selected = await chooseEligibleCloudflareAccount(eligibleAccounts);
  if (selected !== "sign-in") {
    return selected;
  }
  const signedIn = await signInToAnotherCloudflareAccount(existingProfiles);
  const inspected = await inspectCloudflareAccounts(signedIn);
  printCloudflareAccountCheck(inspected.eligibility);
  validateEligibleCloudflareAccounts(inspected.eligibleAccounts);
  const account = await select({
    message: "Which Cloudflare account will run and bill for this runner pool?",
    choices: inspected.eligibleAccounts.map((candidate) => ({
      name: `${candidate.account.name} (${candidate.account.id}) — ${runnerPoolSummary(candidate.runnerPool)} — Wrangler profile: ${candidate.profile}`,
      value: candidate,
    })),
  });
  return account;
}

async function validateCloudflareToken(token, accountId) {
  const [applications, tagsResponse] = await Promise.all([
    cloudflareRequest(token, accountId, "/applications"),
    fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/tags/keys`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    }),
  ]);
  if (!Array.isArray(applications)) {
    throw new Error("Cloudflare returned an unexpected Container application list");
  }
  const tags = z.object({ success: z.literal(true), result: z.array(z.json()) }).safeParse(await tagsResponse.json());
  if (!tagsResponse.ok || !tags.success) {
    throw new Error("Cloudflare token requires Tag Read access for safe resource ownership");
  }
  return applications;
}

function parseGitHubApiPages(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("GitHub CLI returned invalid JSON");
  }
  if (!Array.isArray(parsed)) {
    return [parsed];
  }
  return parsed.flatMap((page) => (Array.isArray(page) ? page : [page]));
}

export function parseGitHubAccounts(userText, organizationsText) {
  let user;
  try {
    user = JSON.parse(userText);
  } catch {
    throw new Error("GitHub CLI returned invalid current-user information");
  }
  const parsedUser = z.object({ login: nonEmptyStringSchema, name: optionalStringSchema }).safeParse(user);
  if (!parsedUser.success) {
    throw new Error("GitHub CLI did not return the current username");
  }
  const organizations = parseGitHubApiPages(organizationsText)
    .flatMap((organization) => {
      const parsed = z.object({ login: nonEmptyStringSchema, name: optionalStringSchema }).safeParse(organization);
      return parsed.success ? [parsed.data] : [];
    })
    .sort((left, right) => left.login.localeCompare(right.login));
  return {
    personal: parsedUser.data,
    organizations,
  };
}

export function parseGitHubAppOwners(userText, membershipsText) {
  const personal = parseGitHubAccounts(userText, "[]").personal;
  const organizations = parseGitHubApiPages(membershipsText)
    .flatMap((membership) => {
      const parsed = z
        .object({
          state: z.literal("active"),
          role: z.literal("admin"),
          organization: z.object({ login: nonEmptyStringSchema, name: optionalStringSchema }),
        })
        .safeParse(membership);
      if (!parsed.success) {
        return [];
      }
      return [
        {
          type: "organization",
          login: parsed.data.organization.login,
          name: parsed.data.organization.name,
        },
      ];
    })
    .sort((left, right) => left.login.localeCompare(right.login));
  return [{ type: "personal", login: personal.login, name: personal.name }, ...organizations];
}

export function githubOwnerNames(githubAccounts) {
  return [githubAccounts.personal.login, ...githubAccounts.organizations.map((organization) => organization.login)];
}

export function parseGitHubRepositories(value, owner) {
  return parseGitHubApiPages(value)
    .flatMap((repository) => {
      const parsed = z
        .object({ name: z.string(), full_name: z.string(), owner: z.object({ login: z.string() }) })
        .safeParse(repository);
      if (!parsed.success || parsed.data.owner.login.toLowerCase() !== owner.toLowerCase()) {
        return [];
      }
      return [{ name: parsed.data.name, fullName: parsed.data.full_name }];
    })
    .sort((left, right) => left.fullName.localeCompare(right.fullName));
}

async function githubAppOwners() {
  const [user, memberships] = await Promise.all([
    runCommand(githubCommand, ["api", "user"], { quiet: true }),
    runCommand(githubCommand, ["api", "--paginate", "--slurp", "user/memberships/orgs?per_page=100"], { quiet: true }),
  ]);
  return parseGitHubAppOwners(user.stdout, memberships.stdout);
}

export function githubOwnerLabel(owner, { previouslyConfigured = false } = {}) {
  const label =
    owner.type === "personal"
      ? `personal: ${owner.login}`
      : `org: ${owner.name === undefined ? owner.login : `${owner.name} (${owner.login})`}`;
  return previouslyConfigured ? `${label} (previously configured)` : label;
}

function sameGitHubOwner(left, right) {
  const leftLogin = nonEmptyStringSchema.safeParse(left?.login);
  const rightLogin = nonEmptyStringSchema.safeParse(right?.login);
  return leftLogin.success && rightLogin.success && leftLogin.data.toLowerCase() === rightLogin.data.toLowerCase();
}

function githubAppInstallationForOwner(status, owner) {
  return status.installations.find((installation) => installation.account.toLowerCase() === owner.login.toLowerCase());
}

export function githubAppCanServeRunnerOwner(status, owner) {
  const installation = githubAppInstallationForOwner(status, owner);
  return (
    status.events.includes("push") &&
    status.events.includes("workflow_job") &&
    installation !== undefined &&
    installation.repositorySelection === "all" &&
    installationCanReadActions(installation) &&
    installationCanReadContents(installation) &&
    installationCanWriteAdministration(installation) &&
    installationCanWriteChecks(installation)
  );
}

export function orderedGitHubRunnerOwners(owners, previouslyConfiguredOwner) {
  return owners
    .map((owner, index) => ({
      owner,
      index,
      previouslyConfigured: sameGitHubOwner(owner, { login: previouslyConfiguredOwner }),
    }))
    .sort(
      (left, right) =>
        Number(right.previouslyConfigured) - Number(left.previouslyConfigured) || left.index - right.index,
    )
    .map(({ owner, previouslyConfigured }) => ({ owner, previouslyConfigured }));
}

async function chooseGitHubRunnerOwner(owners, previouslyConfiguredOwner) {
  return select({
    message: "Which GitHub account or organization should this runner pool serve?",
    choices: orderedGitHubRunnerOwners(owners, previouslyConfiguredOwner).map(({ owner, previouslyConfigured }) => ({
      name: githubOwnerLabel(owner, { previouslyConfigured }),
      value: owner,
    })),
  });
}

export function githubAppManifestRegistrationUrl(owner) {
  const parsedOwner = z.object({ type: z.literal("organization"), login: nonEmptyStringSchema }).safeParse(owner);
  if (parsedOwner.success) {
    return `https://github.com/organizations/${encodeURIComponent(parsedOwner.data.login)}/settings/apps/new`;
  }
  return "https://github.com/settings/apps/new";
}

async function promptForValidatedCloudflareToken(cloudflareAccount, { showTokenForm }) {
  if (showTokenForm) {
    const cloudflareTokenUrl = cloudflareContainersTokenTemplateUrl();
    console.log("\nOpening Cloudflare's prefilled account-owned Containers Write + Tag Read/Write token form...");
    console.log("Creating an account-owned token requires a Cloudflare Super Administrator role.");
    openExternalUrl(cloudflareTokenUrl);
    console.log(
      "Review the prefilled account token and select Create Token. If a browser did not open, use:\n" +
        cloudflareTokenUrl,
    );
  }

  const requestToken = async () => {
    const cloudflareToken = (
      await password({
        message: "Account-owned Cloudflare Containers Write + Tag Read/Write API token",
        mask: true,
        validate: (value) => value.trim().length > 0 || "A Cloudflare API token is required",
      })
    ).trim();
    try {
      await withSpinner("Validating Cloudflare account and token permissions", "Cloudflare token: valid", () =>
        validateCloudflareToken(cloudflareToken, cloudflareAccount.id),
      );
      return cloudflareToken;
    } catch (error) {
      console.log(`  Cloudflare token was not accepted: ${error instanceof Error ? error.message : String(error)}`);
      const retry = await confirm({ message: "Try another Cloudflare token?", default: true });
      if (!retry) {
        throw error;
      }
      return requestToken();
    }
  };
  return requestToken();
}

async function verifyWorker(workerBaseUrl) {
  let response;
  try {
    response = await fetch(`${workerBaseUrl}/healthz`);
  } catch {
    throw new WorkerHealthCheckError(undefined, workerBaseUrl);
  }
  if (!response.ok) {
    throw new WorkerHealthCheckError(response.status, workerBaseUrl);
  }

  const body = await response.json();
  if (body?.ok !== true) {
    throw new Error("Worker health check returned an unexpected response");
  }
}

async function putWorkerSecret(name, value, cloudflareEnvironment) {
  await runCommand(npxCommand, wranglerArguments(["secret", "put", name], cloudflareEnvironment.WRANGLER_PROFILE), {
    environment: cloudflareEnvironment,
    input: `${value}\n`,
    quiet: true,
  });
}

/** Wrangler applies a bulk secret update as one Worker version. */
async function putWorkerSecrets(values, cloudflareEnvironment) {
  await runCommand(npxCommand, wranglerArguments(["secret", "bulk"], cloudflareEnvironment.WRANGLER_PROFILE), {
    environment: cloudflareEnvironment,
    input: `${JSON.stringify(values)}\n`,
    quiet: true,
  });
}

async function deleteWorkerSecret(name, cloudflareEnvironment) {
  await runCommand(npxCommand, wranglerArguments(["secret", "delete", name], cloudflareEnvironment.WRANGLER_PROFILE), {
    environment: cloudflareEnvironment,
    input: "y\n",
    quiet: true,
  });
}

async function validateExistingWorkerTokens(workerBaseUrl, setupValidationToken) {
  const response = await fetch(`${workerBaseUrl}/v1/setup/validate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${setupValidationToken}`, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!response.ok) {
    throw new WorkerTokenValidationError(response.status);
  }
  return parseRunnerSetupTokenStatus(await response.text());
}

async function validateUpdatedWorkerTokens(workerBaseUrl, setupValidationToken) {
  return withSpinner(
    "Checking updated Worker token configuration",
    (status) =>
      hasValidRunnerSetupTokenStatus(status)
        ? { message: "Worker token configuration: valid" }
        : { color: "red", marker: "✘", message: "Worker token configuration: needs attention" },
    () =>
      waitForWorkerTokenValidation(() => validateExistingWorkerTokens(workerBaseUrl, setupValidationToken), {
        isValid: hasValidRunnerSetupTokenStatus,
      }),
  );
}

async function workerGitHubAppStatus(workerBaseUrl, setupValidationToken, pending = false) {
  const endpoint = pending ? "/v1/setup/github-app?pending=1" : "/v1/setup/github-app";
  const response = await waitForWorkerSetupAuthorization(() =>
    fetch(`${workerBaseUrl}${endpoint}`, {
      headers: { Authorization: `Bearer ${setupValidationToken}` },
    }),
  );
  if (!response.ok) {
    throw new Error(`Worker GitHub App status check failed with status ${response.status}`);
  }
  const result = await response.json();
  const parsedResult = z
    .object({
      configured: z.boolean(),
      valid: z.boolean(),
      id: z.number().int().positive().optional(),
      slug: optionalStringSchema,
      owner: z.json().optional(),
      events: z.array(z.string()),
      installations: z.array(z.json()),
    })
    .safeParse(result);
  if (!parsedResult.success) {
    throw new Error("Worker returned an invalid GitHub App status");
  }
  return parsedResult.data;
}

async function workerCloudflareTokenIdentity(workerBaseUrl, setupValidationToken) {
  const response = await waitForWorkerSetupAuthorization(() =>
    fetch(`${workerBaseUrl}/v1/setup/cloudflare-token`, {
      headers: { Authorization: `Bearer ${setupValidationToken}` },
    }),
  );
  if (!response.ok) {
    throw new Error(`Worker Cloudflare token identity check failed with status ${response.status}`);
  }
  const result = z
    .object({ token: z.object({ id: z.string().length(32) }).nullish() })
    .safeParse(await response.json());
  if (!result.success || result.data.token === undefined || result.data.token === null) {
    throw new Error("Worker did not return the managed Cloudflare token ID");
  }
  return result.data.token;
}

async function recordWorkerResourceOwnership(workerBaseUrl, setupValidationToken) {
  const response = await waitForWorkerSetupAuthorization(
    () =>
      fetch(`${workerBaseUrl}/v1/setup/resource-ownership`, {
        method: "POST",
        headers: { Authorization: `Bearer ${setupValidationToken}` },
      }),
    { retryStatuses: [401, 404] },
  );
  if (!response.ok) {
    throw new Error(`Worker resource ownership recording failed with status ${response.status}`);
  }
  const result = z.object({ installationId: z.uuid() }).safeParse(await response.json());
  if (!result.success) {
    throw new Error("Worker returned an invalid resource ownership result");
  }
  return result.data;
}

async function startRemoteRunnerImageBuild(workerBaseUrl, setupValidationToken) {
  const response = await waitForWorkerSetupAuthorization(() =>
    fetch(`${workerBaseUrl}/v1/setup/runner-image/build`, {
      method: "POST",
      headers: { Authorization: `Bearer ${setupValidationToken}` },
    }),
  );
  if (!response.ok) {
    throw new Error(`Could not start the remote runner image build (status ${response.status})`);
  }
  const result = z.object({ workflowId: nonEmptyStringSchema }).safeParse(await response.json());
  if (!result.success) {
    throw new Error("Worker did not return a remote runner image build workflow ID");
  }
  return result.data.workflowId;
}

export function cloudflareWorkflowInstanceUrl(accountId, workflowName, instanceId) {
  const parts = [accountId, workflowName, instanceId].map((part) =>
    encodeURIComponent(nonEmptyStringSchema.parse(part)),
  );
  return `https://dash.cloudflare.com/${parts[0]}/workers/workflows/${parts[1]}/instance/${parts[2]}`;
}

export function remoteRunnerImageBuildProgressMessage(status) {
  const phase = status?.progress?.phase;
  const phases = {
    queued: "Waiting for Cloudflare to schedule the image build",
    "bootstrapping-builder": "Bootstrapping Cloudflare's private daemonless image builder",
    "rolling-out-builder": "Rolling Cloudflare's private daemonless image builder to its private image",
    "downloading-source": "Downloading the runner-image source from GitHub",
    "starting-builder": "Starting Cloudflare's isolated daemonless image builder",
    "preparing-build-context": "Preparing the runner image build context",
    "checking-image-cache": "Checking whether this runner image already exists",
    "building-and-pushing": "Building and pushing the runner image to Cloudflare's private registry",
    "rolling-out": "Rolling runner profiles to the new image",
  };
  const parsedPhase = z.enum(Object.keys(phases)).safeParse(phase);
  if (parsedPhase.success) {
    const message = phases[parsedPhase.data];
    if (parsedPhase.data !== "rolling-out") {
      return message;
    }
    const rollout = z
      .object({
        processedApplications: z.number().int().nonnegative(),
        totalApplications: z.number().int().nonnegative(),
      })
      .safeParse(status?.progress?.rollout);
    return rollout.success
      ? `${message} (${rollout.data.processedApplications}/${rollout.data.totalApplications} profiles checked)`
      : message;
  }
  if (status?.status === "queued") {
    return phases.queued;
  }
  if (status?.status === "running" || status?.status === "waiting") {
    return "Cloudflare is preparing the runner image build";
  }
  return undefined;
}

export function remoteRunnerImageBuildFailure(status) {
  const detail = z.string().safeParse(status?.error).data?.trim() ?? "";
  return detail === ""
    ? "Cloudflare could not build the runner image; check Worker logs for the non-sensitive build failure"
    : `Cloudflare could not build the runner image: ${detail}`;
}

export async function retryRemoteRunnerImageBuild(operation, options = {}) {
  const { confirmRetry = confirm, reportFailure = (message) => console.log(message) } = options;
  try {
    return await operation();
  } catch (error) {
    reportFailure(`\n${error instanceof Error ? error.message : String(error)}`);
    const retry = await confirmRetry({
      message: "Try building the shared runner image again?",
      default: true,
    });
    if (!retry) {
      throw error;
    }
    return retryRemoteRunnerImageBuild(operation, options);
  }
}

async function verifyRemoteRunnerImageSource(workerBaseUrl, setupValidationToken) {
  const response = await waitForWorkerSetupAuthorization(() =>
    fetch(`${workerBaseUrl}/v1/setup/runner-image/source`, {
      headers: { Authorization: `Bearer ${setupValidationToken}` },
    }),
  );
  if (!response.ok) {
    throw new Error(`Could not check runner-image source access (status ${response.status})`);
  }
  const source = z
    .object({ available: z.boolean(), repository: z.string(), ref: z.string() })
    .safeParse(await response.json());
  if (!source.success) {
    throw new Error("Worker returned an invalid runner-image source check");
  }
  return source.data;
}

export async function waitForRemoteRunnerImageBuild(workerBaseUrl, setupValidationToken, workflowId, options = {}) {
  const { fetcher = fetch, maximumConsecutivePollFailures = 15, onProgress = () => {}, pollDelayMs = 2_000 } = options;
  let lastProgressMessage;
  let consecutivePollFailures = 0;
  // A setup Workflow can join a healthy three-hour private-builder bootstrap,
  // then still stage up to three coalesced source builds and roll out its own
  // runner image. Keep the CLI attached through that complete healthy path
  // rather than timing out mid-progress.
  for (let attempt = 1; attempt <= 21_600; attempt += 1) {
    let response;
    try {
      // eslint-disable-next-line no-await-in-loop -- status polling must observe the workflow in order.
      response = await waitForWorkerSetupAuthorization(() =>
        fetcher(`${workerBaseUrl}/v1/setup/runner-image/build/${encodeURIComponent(workflowId)}`, {
          headers: { Authorization: `Bearer ${setupValidationToken}` },
        }),
      );
    } catch (error) {
      consecutivePollFailures += 1;
      if (consecutivePollFailures >= maximumConsecutivePollFailures) {
        throw new Error(
          `Could not check the remote runner image build after ${maximumConsecutivePollFailures} consecutive network failures`,
          { cause: error },
        );
      }
      // A brief client-side network interruption must not exit setup and
      // remove its temporary Worker secret while the remote build is healthy.
      // eslint-disable-next-line no-await-in-loop -- retry this same remote Workflow after the transient failure.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, pollDelayMs));
      continue;
    }
    if (!response.ok) {
      throw new Error(`Could not check the remote runner image build (status ${response.status})`);
    }
    consecutivePollFailures = 0;
    // eslint-disable-next-line no-await-in-loop -- each status response determines whether another poll is required.
    const status = await response.json();
    const progressMessage = remoteRunnerImageBuildProgressMessage(status);
    if (progressMessage !== undefined && progressMessage !== lastProgressMessage) {
      onProgress(progressMessage);
      lastProgressMessage = progressMessage;
    }
    if (status?.status === "complete") {
      return status.result;
    }
    if (status?.status === "errored" || status?.status === "terminated") {
      throw new Error(remoteRunnerImageBuildFailure(status));
    }
    // eslint-disable-next-line no-await-in-loop -- a remote image build may take several minutes.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollDelayMs));
  }
  throw new Error("Cloudflare runner image build did not finish within 720 minutes");
}

function installationCanReadActions(installation) {
  return installation?.actionsRead === true;
}

function installationCanReadContents(installation) {
  return installation?.contentsRead === true;
}

function installationCanWriteAdministration(installation) {
  return installation?.administrationWrite === true;
}

function installationCanWriteChecks(installation) {
  return installation?.checksWrite === true;
}

async function retryWorkerValidationAuthorization(operation) {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof WorkerTokenValidationError) || error.status !== 401) {
      throw error;
    }
    console.log("\nThe Worker has not yet accepted its temporary setup credential.");
    const retry = await confirm({ message: "Check the Worker again?", default: true });
    return retry ? retryWorkerValidationAuthorization(operation) : undefined;
  }
}

function printWorkerTokenConfigurationIssue(status) {
  console.log("\nThe Worker could not validate all stored credentials:");
  if (!status.cloudflareContainersToken) {
    console.log("  ✘ Cloudflare Containers token: unavailable to the Worker");
  }
  if (!status.cloudflareRegistryPush) {
    console.log("  ✘ Cloudflare Container registry push: unavailable to the Worker");
  }
  if (!status.cloudflareResourceTagging) {
    console.log("  ✘ Cloudflare resource tagging: unavailable to the Worker");
  }
  if (!status.githubApp) {
    console.log("  ✘ GitHub App credentials: unavailable or rejected by GitHub");
  }
  if (!status.githubAppWebhookSecret) {
    console.log("  ✘ GitHub App webhook secret: unavailable to the Worker");
  }
  if (!status.resourceTraceSigningKey) {
    console.log("  ✘ Runner resource-trace signing key: unavailable to the Worker");
  }
  if (!status.runnerCacheSigningKey) {
    console.log("  ✘ Runner R2-cache signing key: unavailable to the Worker");
  }
}

async function chooseWorkerTokenRecovery(status) {
  const choices = [{ name: "Check again", value: "check" }];
  if (!status.cloudflareContainersToken || !status.cloudflareRegistryPush || !status.cloudflareResourceTagging) {
    choices.push({ name: "Replace the Cloudflare Containers token", value: "cloudflare" });
  }
  if (!status.githubApp || !status.githubAppWebhookSecret) {
    choices.push({ name: "Create a new GitHub App", value: "github-app" });
  }
  choices.push({ name: "Stop setup", value: "stop" });
  return select({ message: "How would you like to continue?", choices });
}

async function storeGitHubAppCredentials(app, cloudflareEnvironment, githubRunnerOwner) {
  const secrets = {
    GITHUB_APP_ID: app.id,
    GITHUB_APP_PRIVATE_KEY: app.privateKey,
    GITHUB_APP_WEBHOOK_SECRET: app.webhookSecret,
  };
  if (githubRunnerOwner !== undefined) {
    secrets.GITHUB_RUNNER_OWNER = githubRunnerOwner;
  }
  await putWorkerSecrets(secrets, cloudflareEnvironment);
}

const pendingGitHubAppSecretNames = [
  "PENDING_GITHUB_APP_ID",
  "PENDING_GITHUB_APP_PRIVATE_KEY",
  "PENDING_GITHUB_APP_WEBHOOK_SECRET",
];

async function storePendingGitHubAppCredentials(app, cloudflareEnvironment) {
  await putWorkerSecrets(
    {
      PENDING_GITHUB_APP_ID: app.id,
      PENDING_GITHUB_APP_PRIVATE_KEY: app.privateKey,
      PENDING_GITHUB_APP_WEBHOOK_SECRET: app.webhookSecret,
    },
    cloudflareEnvironment,
  );
}

async function deletePendingGitHubAppCredentials(cloudflareEnvironment) {
  await putWorkerSecrets(
    Object.fromEntries(pendingGitHubAppSecretNames.map((name) => [name, null])),
    cloudflareEnvironment,
  );
}

async function deleteGitHubAppCredentials(cloudflareEnvironment) {
  await putWorkerSecrets(
    {
      GITHUB_APP_ID: null,
      GITHUB_APP_PRIVATE_KEY: null,
      GITHUB_APP_WEBHOOK_SECRET: null,
    },
    cloudflareEnvironment,
  );
}

function githubAppInstallUrl(slug) {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}

async function installGitHubApp(slug, workerBaseUrl, setupValidationToken, githubRunnerOwner, pending = false) {
  const installUrl = githubAppInstallUrl(slug);
  console.log(`\nOpening the GitHub App installation page: ${installUrl}`);
  console.log(
    `Install the App on ${githubOwnerLabel(githubRunnerOwner)} and select All repositories.\n` +
      "If a browser did not open, use the link above.",
  );
  openExternalUrl(installUrl);

  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- interactive polling must wait for the user before querying GitHub.
    const continueSetup = await confirm({
      message: "I installed the GitHub App. Check the installations now?",
      default: true,
    });
    if (!continueSetup) {
      return undefined;
    }
    // eslint-disable-next-line no-await-in-loop -- wait for each installation check before asking again.
    const status = await withSpinner("Checking GitHub App installations", "GitHub App installations: checked", () =>
      workerGitHubAppStatus(workerBaseUrl, setupValidationToken, pending),
    );
    const installation = githubAppInstallationForOwner(status, githubRunnerOwner);
    if (installation !== undefined) {
      console.log(
        status.installations
          .map(
            (candidate) =>
              `  ✔ ${candidate.account} (${candidate.accountType}) — ${candidate.repositorySelection} repositories${
                installationCanReadActions(candidate) ? " — Actions: Read" : " — Actions: unavailable"
              }${installationCanReadContents(candidate) ? " — Contents: Read" : " — Contents: unavailable"}${
                installationCanWriteAdministration(candidate)
                  ? " — Administration: Write"
                  : " — Administration: unavailable"
              }${installationCanWriteChecks(candidate) ? " — Checks: Write" : " — Checks: unavailable"}`,
          )
          .join("\n"),
      );
      if (githubAppCanServeRunnerOwner(status, githubRunnerOwner)) {
        return status;
      }
      console.log(
        `  The App must be installed on ${githubOwnerLabel(githubRunnerOwner)} for All repositories with ` +
          "Actions: Read, Contents: Read, Administration: Write, and Checks: Write.",
      );
      continue;
    }
    console.log(`  No GitHub App installation is visible for ${githubOwnerLabel(githubRunnerOwner)} yet.`);
  }
}

export async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Setup is interactive and must be run in a terminal");
  }

  console.log("Cloudflare GitHub Actions runner setup");
  console.log(
    "Cloudflare runners support private GitHub repositories only. Public and internal Cloudflare-targeting jobs are rejected; unrelated jobs are ignored.",
  );
  console.log(
    "The GitHub App retains its configured repository permissions wherever it is installed; runtime eligibility controls runner compute and does not change GitHub contributor approval policies.",
  );

  const cloudflareProfiles = await withSpinner(
    "Checking Cloudflare authentication profiles",
    "Cloudflare authentication profiles: available",
    existingCloudflareProfiles,
  );
  const cloudflareInspections = await withSpinner(
    "Checking Cloudflare accounts",
    "Cloudflare account check",
    async () => {
      const inspections = await Promise.all(cloudflareProfiles.map((profile) => inspectCloudflareAccounts(profile)));
      const eligibility = collapseCloudflareAccountCandidates(
        inspections.flatMap((inspection) => inspection.eligibility),
      );
      const eligibleAccounts = eligibility.filter(cloudflareAccountIsEligible);
      return { eligibility, eligibleAccounts };
    },
  );
  printCloudflareAccountCheck(cloudflareInspections.eligibility);
  const availableGitHubRunnerOwners = await withSpinner(
    "Checking GitHub accounts and organizations",
    "GitHub accounts and organizations: available",
    githubAppOwners,
  );
  const cloudflareAccount = await chooseCloudflareAccount(
    cloudflareProfiles.map(({ profile }) => profile),
    cloudflareInspections.eligibleAccounts,
  );
  const githubRunnerOwner = await chooseGitHubRunnerOwner(
    availableGitHubRunnerOwners,
    cloudflareAccount.runnerPool.githubRunnerOwner,
  );
  const confirmed = await confirm({
    message: `Set up ${cloudflareAccount.account.name} for ${githubOwnerLabel(githubRunnerOwner)}?`,
    default: true,
  });
  if (!confirmed) {
    console.log("Setup stopped.");
    return;
  }

  let adoptExisting = false;
  let installationId = cloudflareAccount.runnerPool.installationId;
  if (cloudflareAccount.runnerPool.workerFound && cloudflareAccount.runnerPool.ownershipManifest === undefined) {
    adoptExisting = await confirm({
      message:
        "This runner pool predates ownership records. Adopt its exact current resources so teardown can manage them?",
      default: false,
    });
    if (!adoptExisting) {
      console.log("Setup stopped. No unowned resources were adopted or changed.");
      return;
    }
  }
  installationId ??= newRunnerInstallationId();

  const runnerCacheConfiguration = await promptForRunnerCacheConfiguration();

  // `GITHUB_RUNNER_OWNER` is a secret, updated atomically with the App
  // credentials. This public setting is only a prompt-default mirror.
  const previouslyConfiguredOwner =
    cloudflareAccount.runnerPool.githubRunnerOwner ?? cloudflareAccount.runnerPool.legacyGitHubOwner;
  const updatingRunnerPoolOwner =
    previouslyConfiguredOwner !== undefined &&
    !sameGitHubOwner({ login: previouslyConfiguredOwner }, githubRunnerOwner);

  const cloudflareEnvironment = {
    CLOUDFLARE_ACCOUNT_ID: cloudflareAccount.account.id,
    WRANGLER_PROFILE: cloudflareAccount.profile,
    RUNNER_POOL_GITHUB_OWNER: updatingRunnerPoolOwner ? previouslyConfiguredOwner : githubRunnerOwner.login,
    RUNNER_INSTALLATION_ID: installationId,
    ...runnerCacheConfiguration,
  };
  if (adoptExisting) cloudflareEnvironment.RUNNER_ADOPT_EXISTING = "true";
  const deploy = await withSpinner("Initializing Cloudflare deployment", "Worker deployed", ({ updateStatus }) =>
    runCommand(process.execPath, [require.resolve("tsx/cli"), "scripts/deploy.ts"], {
      environment: cloudflareEnvironment,
      quiet: true,
      onOutput: deploymentProgressReporter(updateStatus),
    }),
  );
  const detectedWorkerUrl = extractWorkerBaseUrl(`${deploy.stdout}\n${deploy.stderr}`);
  const workerBaseUrl =
    detectedWorkerUrl === undefined
      ? normalizeWorkerBaseUrl(
          await input({
            message: "Public Worker base URL",
            validate: (value) => normalizeWorkerBaseUrl(value) !== undefined || "Enter a valid HTTPS URL",
          }),
        )
      : normalizeWorkerBaseUrl(detectedWorkerUrl);
  if (workerBaseUrl === undefined) {
    throw new Error("The Worker URL was invalid");
  }
  await withSpinner("Checking Worker health", "Worker health: available", () =>
    waitForWorkerHealthCheck(() => verifyWorker(workerBaseUrl)),
  );
  const createGitHubApp = () =>
    createGitHubAppFromManifest(`Cloudflare Actions Runner ${cloudflareAccount.account.id.slice(-8)}`, workerBaseUrl, {
      owner: githubRunnerOwner,
    });

  const setupValidationToken = generateWebhookSecret();
  const existingGitHubAppConfiguration = cloudflareAccount.runnerPool.githubAppConfigured;
  const existingTokens = await retryWorkerValidationAuthorization(() =>
    withSpinner(
      "Checking existing Worker token configuration",
      "Worker token configuration: checked",
      async ({ runStep }) => {
        await runStep(
          "Saving the selected Cloudflare account for the Worker",
          "Selected Cloudflare account saved for the Worker",
          () => putWorkerSecret("CLOUDFLARE_ACCOUNT_ID", cloudflareAccount.account.id, cloudflareEnvironment),
        );
        await runStep(
          "Authorizing this setup session with the Worker",
          "Setup session authorized with the Worker",
          () => putWorkerSecret("RUNNER_SETUP_VALIDATION_TOKEN", setupValidationToken, cloudflareEnvironment),
        );
        return runStep(
          "Validating the Worker's existing Cloudflare and GitHub App credentials",
          "Existing Worker credentials validated",
          () =>
            retryWorkerTokenValidation(() => validateExistingWorkerTokens(workerBaseUrl, setupValidationToken), {
              // An existing App can take a short time to become visible after the
              // deployment that introduced this setup session. Do not create a
              // duplicate App merely because GitHub has not accepted its JWT yet.
              isValid: existingGitHubAppConfiguration
                ? (status) => status.githubApp && status.githubAppWebhookSecret
                : () => true,
            }),
        );
      },
    ),
  );
  if (existingTokens === undefined) {
    await deleteWorkerSecret("RUNNER_SETUP_VALIDATION_TOKEN", cloudflareEnvironment);
    console.log("Setup stopped. The temporary setup credential was removed.");
    return;
  }
  console.log("\nExisting Worker credential status:");
  for (const message of existingWorkerTokenStatusMessages(existingTokens)) {
    console.log(`  ${message}`);
  }

  let discardUninstalledInitialGitHubAppCredentials = false;
  try {
    let cloudflareToken;
    const existingCloudflareTokenIsValid =
      existingTokens.cloudflareContainersToken &&
      existingTokens.cloudflareRegistryPush &&
      existingTokens.cloudflareResourceTagging;
    if (!existingCloudflareTokenIsValid) {
      cloudflareToken = await promptForValidatedCloudflareToken(cloudflareAccount.account, { showTokenForm: true });
      await putWorkerSecret("CLOUDFLARE_CONTAINERS_API_TOKEN", cloudflareToken, cloudflareEnvironment);
    }

    let createdGitHubApp;
    let replacementGitHubAppIsPending = false;
    const existingGitHubAppIsValid = existingTokens.githubApp && existingTokens.githubAppWebhookSecret;
    if (!existingGitHubAppIsValid) {
      if (!shouldCreateInitialGitHubApp(existingTokens, existingGitHubAppConfiguration)) {
        console.log(
          "  ! Found an existing GitHub App configuration, but GitHub did not validate it. Keeping it until you choose recovery.",
        );
      } else {
        createdGitHubApp = await createGitHubApp();
        await storeGitHubAppCredentials(createdGitHubApp, cloudflareEnvironment);
        discardUninstalledInitialGitHubAppCredentials = true;
      }
    }

    if (!existingTokens.resourceTraceSigningKey) {
      await putWorkerSecret("RESOURCE_TRACE_SIGNING_KEY", generateResourceTraceSigningKey(), cloudflareEnvironment);
    }
    if (!existingTokens.runnerCacheSigningKey) {
      await putWorkerSecret("RUNNER_CACHE_SIGNING_KEY", generateResourceTraceSigningKey(), cloudflareEnvironment);
    }

    const recoverWorkerTokenConfiguration = async () => {
      const validatedTokens = await retryWorkerValidationAuthorization(() =>
        validateUpdatedWorkerTokens(workerBaseUrl, setupValidationToken),
      );
      if (validatedTokens === undefined) {
        console.log("Setup stopped; any saved credentials remain in place.");
        return false;
      }
      if (hasValidRunnerSetupTokenStatus(validatedTokens)) {
        return true;
      }
      printWorkerTokenConfigurationIssue(validatedTokens);
      const recovery = await chooseWorkerTokenRecovery(validatedTokens);
      if (recovery === "stop") {
        console.log("Setup stopped; any saved credentials remain in place.");
        return false;
      }
      if (recovery === "cloudflare") {
        cloudflareToken = await promptForValidatedCloudflareToken(cloudflareAccount.account, { showTokenForm: false });
        await putWorkerSecret("CLOUDFLARE_CONTAINERS_API_TOKEN", cloudflareToken, cloudflareEnvironment);
      }
      if (recovery === "github-app") {
        createdGitHubApp = await createGitHubApp();
        await storeGitHubAppCredentials(createdGitHubApp, cloudflareEnvironment);
        discardUninstalledInitialGitHubAppCredentials = true;
      }
      if (!validatedTokens.resourceTraceSigningKey) {
        await putWorkerSecret("RESOURCE_TRACE_SIGNING_KEY", generateResourceTraceSigningKey(), cloudflareEnvironment);
      }
      if (!validatedTokens.runnerCacheSigningKey) {
        await putWorkerSecret("RUNNER_CACHE_SIGNING_KEY", generateResourceTraceSigningKey(), cloudflareEnvironment);
      }
      return recoverWorkerTokenConfiguration();
    };
    if (!(await recoverWorkerTokenConfiguration())) {
      return;
    }

    if (cloudflareAccount.runnerPool.githubRunnerOwnerSecretConfigured === false) {
      // Migrate the legacy public owner binding once. Afterwards the value is
      // intentionally opaque to the CLI: every owner change travels with the
      // App credentials in one atomic secret-bulk Worker version.
      await putWorkerSecret(
        "GITHUB_RUNNER_OWNER",
        previouslyConfiguredOwner ?? githubRunnerOwner.login,
        cloudflareEnvironment,
      );
    }

    let appStatus = await withSpinner("Checking GitHub App", "GitHub App: available", () =>
      workerGitHubAppStatus(workerBaseUrl, setupValidationToken),
    );
    const appOwnerMatchesRunnerOwner =
      appStatus.owner === undefined || sameGitHubOwner(appStatus.owner, githubRunnerOwner);
    const existingInstallation = githubAppInstallationForOwner(appStatus, githubRunnerOwner);
    const existingInstallationHasRequiredPermissions =
      existingInstallation === undefined ||
      (existingInstallation.repositorySelection === "all" &&
        installationCanReadActions(existingInstallation) &&
        installationCanReadContents(existingInstallation) &&
        installationCanWriteAdministration(existingInstallation) &&
        installationCanWriteChecks(existingInstallation));
    if (
      !appStatus.events.includes("push") ||
      !appStatus.events.includes("workflow_job") ||
      !appOwnerMatchesRunnerOwner ||
      !existingInstallationHasRequiredPermissions
    ) {
      console.log(
        !appOwnerMatchesRunnerOwner
          ? `\nThe existing GitHub App belongs to ${appStatus.owner.login}, not ${githubRunnerOwner.login}.`
          : !existingInstallationHasRequiredPermissions
            ? "\nThe existing GitHub App must be installed for All repositories with Actions: Read, Contents: Read, Administration: Write, and Checks: Write."
            : "\nThe existing GitHub App needs the workflow_job and push events.",
      );
      const replaceApp = await confirm({
        message: `Create a replacement GitHub App owned by ${githubRunnerOwner.login}?`,
        default: true,
      });
      if (!replaceApp) {
        console.log("Setup stopped. The existing runner configuration remains unchanged.");
        return;
      }
      createdGitHubApp = await createGitHubApp();
      // Keep the currently active App signing webhooks until this replacement
      // has been installed and verified. The candidate lives only in separate
      // Worker secrets and is never exposed to a runner Container.
      await storePendingGitHubAppCredentials(createdGitHubApp, cloudflareEnvironment);
      replacementGitHubAppIsPending = true;
      appStatus = await withSpinner("Checking replacement GitHub App", "GitHub App: available", () =>
        workerGitHubAppStatus(workerBaseUrl, setupValidationToken, true),
      );
    }
    const parsedAppSlug = nonEmptyStringSchema.safeParse(createdGitHubApp?.slug ?? appStatus.slug);
    if (!parsedAppSlug.success) {
      throw new Error("GitHub did not return the GitHub App installation URL");
    }
    const appSlug = parsedAppSlug.data;
    const installedApp = githubAppCanServeRunnerOwner(appStatus, githubRunnerOwner)
      ? appStatus
      : await installGitHubApp(
          appSlug,
          workerBaseUrl,
          setupValidationToken,
          githubRunnerOwner,
          replacementGitHubAppIsPending,
        );
    if (installedApp === undefined) {
      console.log("Setup stopped. The existing GitHub App remains active; the uninstalled replacement was discarded.");
      return;
    }
    if (!githubAppCanServeRunnerOwner(installedApp, githubRunnerOwner)) {
      console.log(
        `Setup stopped. Install the GitHub App on ${githubOwnerLabel(githubRunnerOwner)} with Actions: Read, Contents: Read, and Administration: Write, then run setup again.`,
      );
      return;
    }

    if (replacementGitHubAppIsPending && createdGitHubApp !== undefined) {
      // The App's ID, private key, webhook secret, and allowed owner land in
      // one `secret bulk` Worker version. Either the old complete tuple or
      // this new complete tuple is live if setup is interrupted.
      await storeGitHubAppCredentials(createdGitHubApp, cloudflareEnvironment, githubRunnerOwner.login);
      await deletePendingGitHubAppCredentials(cloudflareEnvironment);
      replacementGitHubAppIsPending = false;
    }
    if (!replacementGitHubAppIsPending) {
      await putWorkerSecret("GITHUB_RUNNER_OWNER", githubRunnerOwner.login, cloudflareEnvironment);
    }
    discardUninstalledInitialGitHubAppCredentials = false;

    if (updatingRunnerPoolOwner) {
      // The functional owner and App credentials were already promoted above
      // atomically. The ownership deployment below updates the display binding.
      cloudflareEnvironment.RUNNER_POOL_GITHUB_OWNER = githubRunnerOwner.login;
    }

    const [cloudflareTokenIdentity, finalAppStatus] = await Promise.all([
      workerCloudflareTokenIdentity(workerBaseUrl, setupValidationToken),
      workerGitHubAppStatus(workerBaseUrl, setupValidationToken),
    ]);
    if (
      finalAppStatus.id === undefined ||
      finalAppStatus.slug === undefined ||
      finalAppStatus.owner?.login === undefined
    ) {
      throw new Error("GitHub did not return enough App identity information to record teardown ownership");
    }
    cloudflareEnvironment.RUNNER_CLOUDFLARE_TOKEN_ID = cloudflareTokenIdentity.id;
    cloudflareEnvironment.RUNNER_GITHUB_APP_ID = String(finalAppStatus.id);
    cloudflareEnvironment.RUNNER_GITHUB_APP_SLUG = finalAppStatus.slug;
    cloudflareEnvironment.RUNNER_GITHUB_APP_OWNER = finalAppStatus.owner.login;
    await withSpinner(
      "Recording runner resource ownership",
      `Resource ownership: recorded (${installationId})`,
      async ({ updateStatus }) => {
        await runCommand(process.execPath, [require.resolve("tsx/cli"), "scripts/deploy.ts"], {
          environment: cloudflareEnvironment,
          quiet: true,
          onOutput: deploymentProgressReporter(updateStatus),
        });
        updateStatus("Applying installation ownership tags");
        await recordWorkerResourceOwnership(workerBaseUrl, setupValidationToken);
      },
    );

    const imageSource = await withSpinner("Checking runner-image source access", "Runner-image source: available", () =>
      verifyRemoteRunnerImageSource(workerBaseUrl, setupValidationToken),
    );
    if (!imageSource.available) {
      console.log(
        `\nSetup stopped. The GitHub App cannot read ${imageSource.repository}@${imageSource.ref}. ` +
          "Install the App on that GitHub account and select this repository (or make the source repository public), then run setup again.",
      );
      return;
    }

    const imageBuild = await retryRemoteRunnerImageBuild(() =>
      withSpinner(
        "Building the shared runner image in Cloudflare",
        (result) => {
          const image = z.string().safeParse(result?.imageReference).data ?? "remote image";
          const status = result?.built === false ? "reused" : "built";
          return { message: `Remote runner image: ${status} (${image})` };
        },
        async ({ pause, resume, updateStatus }) => {
          updateStatus("Starting the shared runner image build in Cloudflare");
          const workflowId = await startRemoteRunnerImageBuild(workerBaseUrl, setupValidationToken);
          const workflowUrl = cloudflareWorkflowInstanceUrl(
            cloudflareEnvironment.CLOUDFLARE_ACCOUNT_ID,
            runnerImageBuildWorkflowName,
            workflowId,
          );
          pause();
          console.log(`Cloudflare build details: ${workflowUrl}`);
          resume();
          return waitForRemoteRunnerImageBuild(workerBaseUrl, setupValidationToken, workflowId, {
            onProgress: updateStatus,
          });
        },
      ),
    );

    const builtImageReference = nonEmptyStringSchema.safeParse(imageBuild?.imageReference).data;
    if (builtImageReference !== undefined) {
      cloudflareEnvironment.RUNNER_CREATED_IMAGE_REFERENCES = JSON.stringify([builtImageReference.split("/").at(-1)]);
    }

    await withSpinner(
      "Recording runner image ownership",
      `Runner image ownership: recorded (${installationId})`,
      async ({ updateStatus }) => {
        await runCommand(process.execPath, [require.resolve("tsx/cli"), "scripts/deploy.ts"], {
          environment: cloudflareEnvironment,
          quiet: true,
          onOutput: deploymentProgressReporter(updateStatus),
        });
        await recordWorkerResourceOwnership(workerBaseUrl, setupValidationToken);
      },
    );

    console.log(
      `\nSetup complete.\n\n` +
        `Worker: ${workerBaseUrl}\n` +
        `GitHub account or organization: ${githubRunnerOwner.login}\n` +
        `${githubAppSetupSummary(appSlug)}\n` +
        `GitHub App installations: ${installedApp.installations.map((installation) => installation.account).join(", ")}\n` +
        `Runner image: ${imageBuild?.imageReference ?? "managed remotely in Cloudflare"}\n` +
        `Runner installation ID: ${installationId}\n` +
        (runnerCacheConfiguration.RUNNER_CACHE_ENABLED === "true"
          ? `R2 storage: ${runnerCacheConfiguration.RUNNER_CACHE_BUCKET_NAME} (dependency-cache FIFO maximum ${runnerCacheConfiguration.RUNNER_CACHE_MAX_SIZE_GB} GB)\n`
          : `R2 storage: ${runnerCacheConfiguration.RUNNER_CACHE_BUCKET_NAME} (temporary image sources only; dependency cache disabled)\n`) +
        `Preset workflow: runs-on: cloudflare-ubuntu-latest\n` +
        `Custom workflow: runs-on: "cloudflare-vcpu:2-memory_mib:6144-disk_mb:12000"\n\n` +
        "The GitHub App private key, webhook secret, and temporary registry credential are kept only in Cloudflare; none are printed or written to disk.\n",
    );
  } finally {
    // A cancelled or failed replacement must leave the previously working App
    // untouched. Pending credentials are only promoted after installation.
    try {
      if (discardUninstalledInitialGitHubAppCredentials) {
        await deleteGitHubAppCredentials(cloudflareEnvironment);
      }
      await deletePendingGitHubAppCredentials(cloudflareEnvironment);
    } finally {
      await deleteWorkerSecret("RUNNER_SETUP_VALIDATION_TOKEN", cloudflareEnvironment);
    }
  }
}
