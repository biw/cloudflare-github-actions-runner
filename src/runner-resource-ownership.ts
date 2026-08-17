import { z } from "zod";

export interface RunnerResourceOwnershipEnvironment {
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_CONTAINERS_API_TOKEN?: string;
  RUNNER_INSTALLATION_ID?: string;
  RUNNER_RESOURCE_MANIFEST?: string;
}

export interface RunnerResourceOwnershipDependencies {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export const runnerOwnershipManagedBy = "cloudflare-github-actions-runner";

const defaultDependencies: RunnerResourceOwnershipDependencies = {
  fetch: (input, init) => fetch(input, init),
};
const nonEmptyStringSchema = z.string().trim().min(1);
const resourceSchema = z.object({ id: nonEmptyStringSchema, type: nonEmptyStringSchema });
const taggedResourceSchema = resourceSchema.extend({
  etag: nonEmptyStringSchema,
  tags: z.record(z.string(), z.string()),
});
const ownershipManifestSchema = z.object({
  version: z.literal(1),
  installationId: z.uuid(),
  accountId: z.string().length(32),
  worker: z.object({ name: nonEmptyStringSchema }),
  database: z.object({ id: nonEmptyStringSchema, name: nonEmptyStringSchema }),
  bucket: z.object({ name: nonEmptyStringSchema }),
});
const cloudflareResponseSchema = z.object({
  success: z.boolean(),
  result: z.json().optional(),
  errors: z.array(z.object({ message: z.string().optional() }).passthrough()).catch([]),
});

function hasValue(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function ownershipManifest(env: RunnerResourceOwnershipEnvironment) {
  if (!hasValue(env.RUNNER_RESOURCE_MANIFEST)) return undefined;
  try {
    const parsed = ownershipManifestSchema.safeParse(JSON.parse(env.RUNNER_RESOURCE_MANIFEST));
    if (
      !parsed.success ||
      parsed.data.accountId !== env.CLOUDFLARE_ACCOUNT_ID ||
      parsed.data.installationId !== env.RUNNER_INSTALLATION_ID
    ) {
      return undefined;
    }
    return parsed.data;
  } catch {
    return undefined;
  }
}

async function cloudflareRequest(
  env: RunnerResourceOwnershipEnvironment,
  path: string,
  init: RequestInit,
  dependencies: RunnerResourceOwnershipDependencies,
) {
  if (!hasValue(env.CLOUDFLARE_ACCOUNT_ID) || !hasValue(env.CLOUDFLARE_CONTAINERS_API_TOKEN)) {
    throw new Error("Runner ownership requires an account-owned Cloudflare token");
  }
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${env.CLOUDFLARE_CONTAINERS_API_TOKEN}`);
  const response = await dependencies.fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}${path}`,
    {
      ...init,
      headers,
    },
  );
  const parsed = cloudflareResponseSchema.safeParse(await response.json());
  if (!response.ok || !parsed.success || !parsed.data.success) {
    const detail = parsed.success ? parsed.data.errors[0]?.message : undefined;
    throw new Error(`Cloudflare ownership API ${response.status}${detail === undefined ? "" : `: ${detail}`}`);
  }
  return parsed.data.result;
}

export async function validCloudflareResourceTagging(
  env: RunnerResourceOwnershipEnvironment,
  dependencies: RunnerResourceOwnershipDependencies = defaultDependencies,
): Promise<boolean> {
  try {
    await cloudflareRequest(env, "/tags/keys", {}, dependencies);
    return true;
  } catch {
    return false;
  }
}

function manifestResources(env: RunnerResourceOwnershipEnvironment) {
  const manifest = ownershipManifest(env);
  if (manifest === undefined) {
    throw new Error("Worker ownership manifest is missing or does not match this installation");
  }
  return {
    installationId: manifest.installationId,
    resources: [
      { type: "worker", id: manifest.worker.name },
      { type: "d1_database", id: manifest.database.id },
      { type: "r2_bucket", id: manifest.bucket.name },
    ],
  };
}

async function existingTaggedResource(
  env: RunnerResourceOwnershipEnvironment,
  resource: z.infer<typeof resourceSchema>,
  dependencies: RunnerResourceOwnershipDependencies,
) {
  const query = new URLSearchParams({ id: resource.id, type: resource.type });
  const result = await cloudflareRequest(env, `/tags/resources?${query}`, {}, dependencies);
  return z
    .array(taggedResourceSchema)
    .parse(result)
    .find(({ id, type }) => id === resource.id && type === resource.type);
}

export async function recordRunnerResourceOwnership(
  env: RunnerResourceOwnershipEnvironment,
  dependencies: RunnerResourceOwnershipDependencies = defaultDependencies,
) {
  const { installationId, resources } = manifestResources(env);
  for (const resource of resources) {
    // eslint-disable-next-line no-await-in-loop -- each GET/merge/PUT uses that resource's current ETag.
    const current = await existingTaggedResource(env, resource, dependencies);
    const headers = new Headers({ "Content-Type": "application/json" });
    if (current !== undefined) headers.set("If-Match", current.etag);
    // eslint-disable-next-line no-await-in-loop -- preserve unrelated tags with optimistic concurrency per resource.
    await cloudflareRequest(
      env,
      "/tags",
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          resource_type: resource.type,
          resource_id: resource.id,
          tags: {
            ...current?.tags,
            "managed-by": runnerOwnershipManagedBy,
            "runner-installation-id": installationId,
          },
        }),
      },
      dependencies,
    );
  }
  return { installationId, resources };
}

export async function inspectRunnerResourceOwnership(
  env: RunnerResourceOwnershipEnvironment,
  dependencies: RunnerResourceOwnershipDependencies = defaultDependencies,
) {
  const { installationId, resources } = manifestResources(env);
  const query = new URLSearchParams();
  query.append("tag", `managed-by=${runnerOwnershipManagedBy}`);
  query.append("tag", `runner-installation-id=${installationId}`);
  const result = await cloudflareRequest(env, `/tags/resources?${query}`, {}, dependencies);
  const expected = new Set(resources.map(({ type, id }) => `${type}:${id}`));
  return z
    .array(taggedResourceSchema)
    .parse(result)
    .filter(({ type, id }) => expected.has(`${type}:${id}`));
}

export function hasValidOwnershipInspectionAuthorization(
  request: Request,
  env: RunnerResourceOwnershipEnvironment,
): boolean {
  return (
    hasValue(env.RUNNER_INSTALLATION_ID) &&
    request.headers.get("X-Runner-Installation-Id") === env.RUNNER_INSTALLATION_ID
  );
}
