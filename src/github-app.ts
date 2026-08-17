import { z } from "zod";

import type { GitHubRepositoryTarget } from "./github-repository";

const githubApiVersion = "2022-11-28";

export interface GitHubAppEnvironment {
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_WEBHOOK_SECRET?: string;
}

export interface GitHubAppInstallation {
  id: number;
  account: string;
  accountType: string;
  repositorySelection: string;
  /** Whether this installation's access tokens include Actions: Read. */
  actionsRead?: boolean;
  /** Whether this installation can provide the private runner-image source. */
  contentsRead?: boolean;
  /** Whether the App can create repository-scoped JIT runners. */
  administrationWrite?: boolean;
  /** Whether the App can report private-repository eligibility failures. */
  checksWrite?: boolean;
}

export interface GitHubAppOwner {
  login: string;
  type?: string;
}

export interface GitHubAppStatus {
  configured: boolean;
  valid: boolean;
  id?: number;
  slug?: string;
  owner?: GitHubAppOwner;
  events: string[];
  installations: GitHubAppInstallation[];
}

interface GitHubInstallationAccessToken {
  token: string;
  actionsRead: boolean;
  contentsRead: boolean;
  administrationWrite: boolean;
  checksWrite: boolean;
}

export interface GitHubAppDependencies {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  now: () => number;
}

export interface RemovedGitHubAppInstallation {
  id: number;
  account: string;
}

/**
 * The cache visibility rules GitHub applies to one workflow run. A pull
 * request receives its own merge-ref namespace and may fall back to the
 * repository default branch; it never writes into that shared namespace.
 */
export interface GitHubWorkflowRunCacheScope {
  scope: string;
  fallbackScope?: string;
  writeAllowed: boolean;
}

export interface GitHubRepositoryArchive {
  body: ReadableStream<Uint8Array> | ArrayBuffer;
}

const maximumBufferedGitHubArchiveBytes = 32 * 1024 * 1024;

const defaultDependencies: GitHubAppDependencies = {
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
};

const nonEmptyStringSchema = z.string().trim().min(1);
const optionalNonEmptyStringSchema = nonEmptyStringSchema.optional().catch(undefined);
const positiveIntegerSchema = z.number().int().positive();
const optionalPositiveIntegerSchema = positiveIntegerSchema.optional().catch(undefined);
const workflowRunSchema = z.object({
  event: z.string().optional().catch(undefined),
  head_branch: optionalNonEmptyStringSchema,
  pull_requests: z
    .array(z.object({ number: optionalPositiveIntegerSchema }))
    .optional()
    .catch(undefined),
});
const installationAccessTokenSchema = z.object({
  token: nonEmptyStringSchema,
  permissions: z
    .object({
      actions: z.string().optional().catch(undefined),
      contents: z.string().optional().catch(undefined),
      administration: z.string().optional().catch(undefined),
      checks: z.string().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});
const installationSchema = z.object({
  id: positiveIntegerSchema,
  account: z.object({ login: nonEmptyStringSchema, type: nonEmptyStringSchema }),
  repository_selection: nonEmptyStringSchema,
});
const appOwnerSchema = z.object({ login: nonEmptyStringSchema, type: optionalNonEmptyStringSchema });
const appSchema = z.object({
  id: positiveIntegerSchema,
  slug: optionalNonEmptyStringSchema,
  events: z.array(z.json()).optional().catch(undefined),
  owner: z.json().optional().catch(undefined),
});
const installationWebhookSchema = z.object({ installation: z.object({ id: positiveIntegerSchema }) });

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function derLength(length: number): Uint8Array {
  if (length < 128) {
    return Uint8Array.of(length);
  }
  const octets = [];
  for (let value = length; value > 0; value >>>= 8) {
    octets.unshift(value & 0xff);
  }
  return Uint8Array.of(0x80 | octets.length, ...octets);
}

function der(tag: number, contents: Uint8Array): Uint8Array {
  const result = new Uint8Array(1 + derLength(contents.length).length + contents.length);
  result[0] = tag;
  result.set(derLength(contents.length), 1);
  result.set(contents, 1 + derLength(contents.length).length);
  return result;
}

function concat(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((length, value) => length + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function pkcs1ToPkcs8(privateKey: Uint8Array): Uint8Array {
  const rsaAlgorithm = Uint8Array.of(
    0x30,
    0x0d,
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
    0x05,
    0x00,
  );
  return der(0x30, concat(Uint8Array.of(0x02, 0x01, 0x00), rsaAlgorithm, der(0x04, privateKey)));
}

function pemBytes(privateKey: string): Uint8Array | undefined {
  const pkcs1 = /-----BEGIN RSA PRIVATE KEY-----/u.test(privateKey);
  const encoded = privateKey
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/gu, "")
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/gu, "")
    .replace(/\s/gu, "");
  if (encoded === "") {
    return undefined;
  }
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return pkcs1 ? pkcs1ToPkcs8(bytes) : bytes;
  } catch {
    return undefined;
  }
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function appCredentials(env: GitHubAppEnvironment): { id: string; privateKey: string } | undefined {
  const id = optionalNonEmptyStringSchema.safeParse(env.GITHUB_APP_ID);
  const privateKey = optionalNonEmptyStringSchema.safeParse(env.GITHUB_APP_PRIVATE_KEY);
  return id.success && id.data !== undefined && privateKey.success && privateKey.data !== undefined
    ? { id: id.data, privateKey: privateKey.data }
    : undefined;
}

async function githubAppJwt(
  env: GitHubAppEnvironment,
  dependencies: GitHubAppDependencies = defaultDependencies,
): Promise<string | undefined> {
  const credentials = appCredentials(env);
  if (credentials === undefined) {
    return undefined;
  }
  const privateKey = pemBytes(credentials.privateKey);
  if (privateKey === undefined) {
    return undefined;
  }

  const issuedAt = Math.floor(dependencies.now() / 1_000) - 60;
  const encodedHeader = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const encodedPayload = base64Url(
    new TextEncoder().encode(JSON.stringify({ iat: issuedAt, exp: issuedAt + 540, iss: credentials.id })),
  );
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  try {
    const key = await crypto.subtle.importKey(
      "pkcs8",
      arrayBuffer(privateKey),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
    return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
  } catch {
    return undefined;
  }
}

function githubHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "cloudflare-github-actions-runner",
    "X-GitHub-Api-Version": githubApiVersion,
  };
}

function githubRepositoryUrl(target: GitHubRepositoryTarget): string {
  return `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}`;
}

/** The archive URL is safe to expose only when paired with a short-lived App token. */
export function githubRepositoryArchiveUrl(target: GitHubRepositoryTarget, ref: string): string {
  return `${githubRepositoryUrl(target)}/tarball/${encodeURIComponent(ref)}`;
}

/** Obtain a short-lived, repository-scoped App credential for the image builder. */
export async function githubRepositoryArchiveToken(
  env: GitHubAppEnvironment,
  target: GitHubRepositoryTarget,
  dependencies: GitHubAppDependencies = defaultDependencies,
): Promise<string | undefined> {
  return githubInstallationAccessTokenForRepository(env, target, dependencies);
}

function defaultBranchCacheScope(defaultBranch: string | undefined): string | undefined {
  const parsed = optionalNonEmptyStringSchema.safeParse(defaultBranch);
  return parsed.success && parsed.data !== undefined ? `refs/heads/${parsed.data}` : undefined;
}

function branchCacheScope(branch: string | undefined): string | undefined {
  return branch === undefined ? undefined : `refs/heads/${branch}`;
}

function pullRequestCacheScope(number: number | undefined): string | undefined {
  return number === undefined ? undefined : `refs/pull/${number}/merge`;
}

const trustedCacheWriteEvents = new Set([
  "delete",
  "page_build",
  "push",
  "registry_package",
  "repository_dispatch",
  "schedule",
  "workflow_dispatch",
]);

/**
 * Mirrors GitHub Actions cache scoping using the App's Actions: Read
 * permission. If GitHub cannot confirm the run, use the default branch only
 * as a read-only fallback rather than risking a shared-cache write.
 */
export async function githubWorkflowRunCacheScope(
  target: GitHubRepositoryTarget,
  workflowRunId: number | undefined,
  defaultBranch: string | undefined,
  token: string | undefined,
  dependencies: GitHubAppDependencies = defaultDependencies,
): Promise<GitHubWorkflowRunCacheScope | undefined> {
  const defaultScope = defaultBranchCacheScope(defaultBranch);
  if (defaultScope === undefined) {
    return undefined;
  }
  if (
    token === undefined ||
    workflowRunId === undefined ||
    !Number.isSafeInteger(workflowRunId) ||
    workflowRunId <= 0
  ) {
    console.log("Cloudflare runner cache scope fell back to read-only default branch", {
      repository: `${target.owner}/${target.repository}`,
      reason: token === undefined ? "missing-installation-token" : "missing-workflow-run-id",
    });
    return { scope: defaultScope, writeAllowed: false };
  }

  try {
    const response = await dependencies.fetch(
      `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}/actions/runs/${workflowRunId}`,
      { headers: githubHeaders(token) },
    );
    if (!response.ok) {
      console.log("Cloudflare runner cache scope fell back to read-only default branch", {
        repository: `${target.owner}/${target.repository}`,
        workflowRunId,
        reason: "workflow-run-request-failed",
        status: response.status,
        acceptedPermissions: response.headers.get("X-Accepted-GitHub-Permissions") ?? undefined,
      });
      return { scope: defaultScope, writeAllowed: false };
    }
    const parsedRun = workflowRunSchema.safeParse(await response.json());
    if (!parsedRun.success) {
      return { scope: defaultScope, writeAllowed: false };
    }
    const run = parsedRun.data;
    if (run.event === "pull_request") {
      const scope = pullRequestCacheScope(run.pull_requests?.[0]?.number);
      if (scope === undefined) {
        console.log("Cloudflare runner cache scope fell back to read-only default branch", {
          repository: `${target.owner}/${target.repository}`,
          workflowRunId,
          reason: "missing-pull-request-number",
        });
      }
      return scope === undefined
        ? { scope: defaultScope, writeAllowed: false }
        : { scope, fallbackScope: defaultScope, writeAllowed: true };
    }
    const scope = branchCacheScope(run.head_branch);
    if (scope === undefined || run.event === undefined || !trustedCacheWriteEvents.has(run.event)) {
      console.log("Cloudflare runner cache scope fell back to read-only default branch", {
        repository: `${target.owner}/${target.repository}`,
        workflowRunId,
        reason: scope === undefined ? "missing-workflow-branch" : "untrusted-workflow-event",
        event: run.event,
      });
      return { scope: defaultScope, writeAllowed: false };
    }
    return scope === defaultScope
      ? { scope, writeAllowed: true }
      : { scope, fallbackScope: defaultScope, writeAllowed: true };
  } catch (error) {
    console.log("Cloudflare runner cache scope fell back to read-only default branch", {
      repository: `${target.owner}/${target.repository}`,
      workflowRunId,
      reason: "workflow-run-request-threw",
      error: error instanceof Error ? error.message : String(error),
    });
    return { scope: defaultScope, writeAllowed: false };
  }
}

async function githubInstallationAccessTokenDetails(
  env: GitHubAppEnvironment,
  installationId: number,
  dependencies: GitHubAppDependencies = defaultDependencies,
): Promise<GitHubInstallationAccessToken | undefined> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return undefined;
  }
  const jwt = await githubAppJwt(env, dependencies);
  if (jwt === undefined) {
    return undefined;
  }
  try {
    const response = await dependencies.fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: githubHeaders(jwt),
      },
    );
    if (!response.ok) {
      return undefined;
    }
    const parsedBody = installationAccessTokenSchema.safeParse(await response.json());
    if (!parsedBody.success) {
      return undefined;
    }
    const body = parsedBody.data;
    return {
      token: body.token,
      actionsRead: body.permissions?.actions === "read" || body.permissions?.actions === "write",
      contentsRead: body.permissions?.contents === "read" || body.permissions?.contents === "write",
      administrationWrite: body.permissions?.administration === "write",
      checksWrite: body.permissions?.checks === "write",
    };
  } catch {
    return undefined;
  }
}

export async function githubInstallationAccessToken(
  env: GitHubAppEnvironment,
  installationId: number,
  dependencies: GitHubAppDependencies = defaultDependencies,
): Promise<string | undefined> {
  return (await githubInstallationAccessTokenDetails(env, installationId, dependencies))?.token;
}

/**
 * Resolve the App installation that owns one repository rather than trusting
 * a caller-provided installation ID. This token is used only to fetch the
 * runner-image source archive inside Worker code; it is never sent to Docker
 * or an Actions runner.
 */
export async function githubInstallationAccessTokenForRepository(
  env: GitHubAppEnvironment,
  target: GitHubRepositoryTarget,
  dependencies: GitHubAppDependencies = defaultDependencies,
): Promise<string | undefined> {
  const jwt = await githubAppJwt(env, dependencies);
  if (jwt === undefined) {
    return undefined;
  }
  try {
    const response = await dependencies.fetch(`${githubRepositoryUrl(target)}/installation`, {
      headers: githubHeaders(jwt),
    });
    if (!response.ok) {
      return undefined;
    }
    const parsedBody = z.object({ id: positiveIntegerSchema }).safeParse(await response.json());
    return parsedBody.success ? githubInstallationAccessToken(env, parsedBody.data.id, dependencies) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Prefer the App's short-lived Contents: Read credential for a private source
 * repository. A public archive fallback preserves upgrades from older Apps
 * that predate that permission, without exposing any App credential to the
 * image-builder Container.
 */
export async function githubRepositoryArchive(
  env: GitHubAppEnvironment,
  target: GitHubRepositoryTarget,
  ref: string,
  dependencies: GitHubAppDependencies = defaultDependencies,
): Promise<ReadableStream<Uint8Array> | undefined> {
  const archive = await githubRepositoryArchiveWithMetadata(env, target, ref, dependencies);
  if (archive === undefined) {
    return undefined;
  }
  return archive.body instanceof ReadableStream ? archive.body : (new Response(archive.body).body ?? undefined);
}

async function bufferGitHubArchive(body: ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  while (true) {
    // eslint-disable-next-line no-await-in-loop -- enforce the archive limit while consuming the response stream.
    const next = await reader.read();
    if (next.done) {
      break;
    }
    size += next.value.byteLength;
    if (size > maximumBufferedGitHubArchiveBytes) {
      // eslint-disable-next-line no-await-in-loop -- stop the response before rejecting the oversized archive.
      await reader.cancel();
      throw new Error("GitHub repository archive exceeds the 32 MiB staging limit");
    }
    chunks.push(next.value);
  }
  const archive = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return archive.buffer;
}

/**
 * Fetch an archive with its length retained for private R2 staging. R2 only
 * accepts streaming request bodies with a known length; GitHub normally sends
 * Content-Length, with a bounded in-memory fallback for unusual responses.
 */
export async function githubRepositoryArchiveWithMetadata(
  env: GitHubAppEnvironment,
  target: GitHubRepositoryTarget,
  ref: string,
  dependencies: GitHubAppDependencies = defaultDependencies,
): Promise<GitHubRepositoryArchive | undefined> {
  const archiveUrl = githubRepositoryArchiveUrl(target, ref);
  const token = await githubInstallationAccessTokenForRepository(env, target, dependencies);
  const fetchArchive = (accessToken: string | undefined) =>
    dependencies.fetch(archiveUrl, {
      headers:
        accessToken === undefined
          ? {
              Accept: "application/vnd.github+json",
              "User-Agent": "cloudflare-github-actions-runner",
              "X-GitHub-Api-Version": githubApiVersion,
            }
          : githubHeaders(accessToken),
    });
  try {
    const authenticated = token === undefined ? undefined : await fetchArchive(token);
    const response = authenticated?.ok ? authenticated : await fetchArchive(undefined);
    if (!response.ok || response.body === null) {
      return undefined;
    }
    const contentLength = response.headers.get("Content-Length");
    if (contentLength !== null) {
      const parsedContentLength = Number(contentLength);
      if (Number.isSafeInteger(parsedContentLength) && parsedContentLength >= 0) {
        return { body: response.body };
      }
    }
    return { body: await bufferGitHubArchive(response.body) };
  } catch {
    return undefined;
  }
}

/**
 * Verify that the Worker can obtain the configured runner-image source without
 * exposing an installation credential. Cancelling the stream immediately
 * avoids downloading the archive twice; the image builder stages it into R2
 * only after this setup-time check succeeds.
 */
export async function githubRepositoryArchiveAvailable(
  env: GitHubAppEnvironment,
  target: GitHubRepositoryTarget,
  ref: string,
  dependencies: GitHubAppDependencies = defaultDependencies,
): Promise<boolean> {
  const archive = await githubRepositoryArchive(env, target, ref, dependencies);
  if (archive === undefined) {
    return false;
  }
  await archive.cancel();
  return true;
}

function parseInstallations(value: readonly z.core.util.JSONType[]): GitHubAppInstallation[] {
  return value.flatMap((installation) => {
    const parsed = installationSchema.safeParse(installation);
    if (!parsed.success) {
      return [];
    }
    return [
      {
        id: parsed.data.id,
        account: parsed.data.account.login,
        accountType: parsed.data.account.type,
        repositorySelection: parsed.data.repository_selection,
      },
    ];
  });
}

/**
 * Remove every installation owned by this App before its private key is
 * discarded. GitHub does not offer an API for deleting the App registration
 * itself, so teardown follows this with an owner-confirmed settings step.
 */
export async function removeGitHubAppInstallations(
  env: GitHubAppEnvironment,
  dependencies: GitHubAppDependencies = defaultDependencies,
): Promise<RemovedGitHubAppInstallation[]> {
  const jwt = await githubAppJwt(env, dependencies);
  if (jwt === undefined) {
    throw new Error("GitHub App credentials are unavailable");
  }

  const installations: GitHubAppInstallation[] = [];
  for (let page = 1; page <= 1_000; page += 1) {
    // eslint-disable-next-line no-await-in-loop -- collect each page before any asynchronous deletion changes the list.
    const response = await dependencies.fetch(`https://api.github.com/app/installations?per_page=100&page=${page}`, {
      headers: githubHeaders(jwt),
    });
    if (!response.ok) {
      throw new Error(`GitHub App installation list failed with status ${response.status}`);
    }
    // eslint-disable-next-line no-await-in-loop -- validate each page before deleting its installations.
    const payload = z.array(z.json()).safeParse(await response.json());
    if (!payload.success) {
      throw new Error("GitHub returned an invalid App installation list");
    }
    const pageInstallations = parseInstallations(payload.data);
    if (pageInstallations.length !== payload.data.length) {
      throw new Error("GitHub returned an invalid App installation");
    }
    installations.push(...pageInstallations);
    if (pageInstallations.length < 100) {
      break;
    }
    if (page === 1_000) {
      throw new Error("GitHub App installation removal exceeded 100,000 installations");
    }
  }

  const removed: RemovedGitHubAppInstallation[] = [];
  for (let offset = 0; offset < installations.length; offset += 25) {
    const chunk = installations.slice(offset, offset + 25);
    // eslint-disable-next-line no-await-in-loop -- bound App-authenticated destructive requests to one small batch.
    const results = await Promise.all(
      chunk.map(async (installation) => {
        const deleteResponse = await dependencies.fetch(`https://api.github.com/app/installations/${installation.id}`, {
          method: "DELETE",
          headers: githubHeaders(jwt),
        });
        if (!deleteResponse.ok) {
          throw new Error(
            `Could not remove the GitHub App installation from ${installation.account} (status ${deleteResponse.status})`,
          );
        }
        return { id: installation.id, account: installation.account };
      }),
    );
    removed.push(...results);
  }
  return removed;
}

function parseGitHubAppOwner(value: z.core.util.JSONType | undefined): GitHubAppOwner | undefined {
  const parsed = appOwnerSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export async function githubAppStatus(
  env: GitHubAppEnvironment,
  dependencies: GitHubAppDependencies = defaultDependencies,
): Promise<GitHubAppStatus> {
  const jwt = await githubAppJwt(env, dependencies);
  if (jwt === undefined) {
    return { configured: appCredentials(env) !== undefined, valid: false, events: [], installations: [] };
  }
  try {
    const appResponse = await dependencies.fetch("https://api.github.com/app", { headers: githubHeaders(jwt) });
    if (!appResponse.ok) {
      return { configured: true, valid: false, events: [], installations: [] };
    }
    const parsedApp = appSchema.safeParse(await appResponse.json());
    if (!parsedApp.success) {
      return { configured: true, valid: false, events: [], installations: [] };
    }
    const app = parsedApp.data;
    const owner = parseGitHubAppOwner(app.owner);
    const installationsResponse = await dependencies.fetch("https://api.github.com/app/installations?per_page=100", {
      headers: githubHeaders(jwt),
    });
    const installationsPayload = installationsResponse.ok
      ? z.array(z.json()).safeParse(await installationsResponse.json())
      : undefined;
    const parsedInstallations =
      installationsPayload?.success === true ? parseInstallations(installationsPayload.data) : [];
    const actionPermissions = await Promise.all(
      parsedInstallations.map(async (installation) => {
        const accessToken = await githubInstallationAccessTokenDetails(env, installation.id, dependencies);
        return accessToken;
      }),
    );
    const status: GitHubAppStatus = {
      configured: true,
      valid: true,
      id: app.id,
      events:
        app.events?.flatMap((event) => {
          const parsedEvent = nonEmptyStringSchema.safeParse(event);
          return parsedEvent.success ? [parsedEvent.data] : [];
        }) ?? [],
      installations: parsedInstallations.map((installation, index) => {
        const result: GitHubAppInstallation = { ...installation };
        const permissions = actionPermissions[index];
        if (permissions !== undefined) {
          result.actionsRead = permissions.actionsRead;
          result.contentsRead = permissions.contentsRead;
          if (permissions.administrationWrite) {
            result.administrationWrite = true;
          }
          result.checksWrite = permissions.checksWrite;
        }
        return result;
      }),
    };
    if (app.slug !== undefined) {
      status.slug = app.slug;
    }
    if (owner !== undefined) {
      status.owner = owner;
    }
    return status;
  } catch {
    return { configured: true, valid: false, events: [], installations: [] };
  }
}

export function hasGitHubAppWebhookSecret(env: GitHubAppEnvironment): boolean {
  return optionalNonEmptyStringSchema.safeParse(env.GITHUB_APP_WEBHOOK_SECRET).data !== undefined;
}

export function githubInstallationFromWebhook(body: string): number | undefined {
  try {
    const parsed = installationWebhookSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data.installation.id : undefined;
  } catch {
    return undefined;
  }
}

export async function githubTokenForRunner(
  env: GitHubAppEnvironment,
  target: GitHubRepositoryTarget,
  installationId: number | null,
  legacyToken: (target: GitHubRepositoryTarget) => Promise<string | undefined>,
  dependencies: GitHubAppDependencies = defaultDependencies,
): Promise<string | undefined> {
  if (installationId !== null) {
    return githubInstallationAccessToken(env, installationId, dependencies);
  }
  return legacyToken(target);
}
