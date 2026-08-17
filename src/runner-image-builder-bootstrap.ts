import { z } from "zod";

import { createContainerRegistryPushCredentials, type ContainerRegistryPushCredentials } from "./cloudflare-containers";
import type { WorkerEnvironment } from "./environment";
import {
  RUNNER_IMAGE_BUILDER_BOOTSTRAP_TAG,
  RUNNER_IMAGE_BUILDER_KANIKO_SOURCE_IMAGE,
  runnerImageBuilderBootstrapReference,
} from "./runner-image";

const sourceRegistry = "https://gcr.io";
const sourceRepository = "kaniko-project/executor";
const cloudflareRegistry = "https://registry.cloudflare.com";
const manifestAccept = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const ociDescriptorSchema = z.object({
  mediaType: z.string(),
  digest: digestSchema,
  size: z.number().int().nonnegative(),
  platform: z.object({ os: z.string().optional(), architecture: z.string().optional() }).optional(),
});
const ociManifestSchema = z.object({
  schemaVersion: z.literal(2),
  mediaType: z.string().optional(),
  config: ociDescriptorSchema,
  layers: z.array(ociDescriptorSchema),
});
const ociIndexSchema = z.object({ manifests: z.array(ociDescriptorSchema) });

type OciDescriptor = z.infer<typeof ociDescriptorSchema>;
type OciManifest = z.infer<typeof ociManifestSchema>;

interface BootstrapDependencies {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  createCredentials: (env: WorkerEnvironment) => Promise<ContainerRegistryPushCredentials>;
}

const defaultDependencies: BootstrapDependencies = {
  fetch: (input, init) => fetch(input, init),
  createCredentials: createContainerRegistryPushCredentials,
};

function bootstrapError(operation: string, status?: number): Error {
  return new Error(
    `Cloudflare could not bootstrap its private daemonless image builder${status === undefined ? "" : ` (${operation} returned ${status})`}`,
  );
}

function sourceImageDigest(): string {
  const digest = RUNNER_IMAGE_BUILDER_KANIKO_SOURCE_IMAGE.split("@")[1];
  const parsedDigest = digestSchema.safeParse(digest);
  if (!parsedDigest.success) {
    throw new Error("The configured daemonless builder source image must use a sha256 digest");
  }
  return parsedDigest.data;
}

/** Select the linux/amd64 image from an OCI/Docker manifest list. */
export function selectLinuxAmd64Manifest(value: z.core.util.JSONType): OciDescriptor | undefined {
  const index = ociIndexSchema.safeParse(value);
  if (!index.success) {
    return undefined;
  }
  return index.data.manifests.find(
    (descriptor) => descriptor.platform?.os === "linux" && descriptor.platform.architecture === "amd64",
  );
}

function targetRepository(env: WorkerEnvironment): string {
  const reference = runnerImageBuilderBootstrapReference(env);
  if (reference === undefined) {
    throw new Error("RUNNER_IMAGE_BUILDER_IMAGE_NAME must identify a Container registry image");
  }
  const path = reference.slice("registry.cloudflare.com/".length);
  const repository = path.slice(0, path.lastIndexOf(":"));
  if (repository === "") {
    throw new Error("Cloudflare produced an invalid private daemonless builder image reference");
  }
  return repository;
}

function targetManifestUrl(repository: string): string {
  return `${cloudflareRegistry}/v2/${repository}/manifests/${RUNNER_IMAGE_BUILDER_BOOTSTRAP_TAG}`;
}

function basicAuthorization(credentials: ContainerRegistryPushCredentials): string {
  return `Basic ${btoa(`${credentials.username}:${credentials.password}`)}`;
}

async function sourceManifest(reference: string, dependencies: BootstrapDependencies): Promise<OciManifest> {
  const response = await dependencies.fetch(`${sourceRegistry}/v2/${sourceRepository}/manifests/${reference}`, {
    headers: { Accept: manifestAccept },
  });
  if (!response.ok) {
    throw bootstrapError("Kaniko image download", response.status);
  }
  const manifest = ociManifestSchema.safeParse(await response.json());
  if (!manifest.success) {
    throw bootstrapError("Kaniko image manifest validation");
  }
  return manifest.data;
}

async function registryBlobExists(
  repository: string,
  digest: string,
  authorization: string,
  dependencies: BootstrapDependencies,
): Promise<boolean> {
  const response = await dependencies.fetch(`${cloudflareRegistry}/v2/${repository}/blobs/${digest}`, {
    method: "HEAD",
    headers: { Authorization: authorization },
  });
  if (response.status === 200) {
    return true;
  }
  if (response.status === 404) {
    return false;
  }
  throw bootstrapError("private registry blob check", response.status);
}

function uploadLocation(value: string | null): URL {
  if (value === null) {
    throw bootstrapError("private registry upload initialization");
  }
  const url = new URL(value, cloudflareRegistry);
  if (url.origin !== cloudflareRegistry) {
    throw bootstrapError("private registry upload initialization");
  }
  return url;
}

async function uploadBlob(
  repository: string,
  descriptor: OciDescriptor,
  source: BodyInit,
  authorization: string,
  dependencies: BootstrapDependencies,
): Promise<void> {
  const create = await dependencies.fetch(`${cloudflareRegistry}/v2/${repository}/blobs/uploads/`, {
    method: "POST",
    headers: { Authorization: authorization },
  });
  if (create.status !== 202) {
    throw bootstrapError("private registry upload initialization", create.status);
  }
  const destination = uploadLocation(create.headers.get("Location"));
  destination.searchParams.set("digest", descriptor.digest);
  const complete = await dependencies.fetch(destination, {
    method: "PUT",
    headers: { Authorization: authorization, "Content-Type": "application/octet-stream" },
    body: source,
  });
  if (complete.status !== 201 && complete.status !== 202) {
    throw bootstrapError("private registry blob upload", complete.status);
  }
}

async function copyBlob(
  repository: string,
  descriptor: OciDescriptor,
  authorization: string,
  dependencies: BootstrapDependencies,
): Promise<void> {
  if (await registryBlobExists(repository, descriptor.digest, authorization, dependencies)) {
    return;
  }
  const source = await dependencies.fetch(`${sourceRegistry}/v2/${sourceRepository}/blobs/${descriptor.digest}`);
  if (!source.ok || source.body === null) {
    throw bootstrapError("Kaniko image layer download", source.status);
  }
  await uploadBlob(repository, descriptor, source.body, authorization, dependencies);
}

async function targetManifestMatches(
  repository: string,
  expectedDigest: string,
  authorization: string,
  dependencies: BootstrapDependencies,
): Promise<boolean> {
  const response = await dependencies.fetch(targetManifestUrl(repository), {
    method: "HEAD",
    headers: { Accept: manifestAccept, Authorization: authorization },
  });
  if (response.status === 200) {
    return response.headers.get("Docker-Content-Digest") === expectedDigest;
  }
  if (response.status === 404) {
    return false;
  }
  throw bootstrapError("private registry image check", response.status);
}

async function publishManifest(
  repository: string,
  manifest: OciManifest,
  authorization: string,
  dependencies: BootstrapDependencies,
): Promise<void> {
  const response = await dependencies.fetch(targetManifestUrl(repository), {
    method: "PUT",
    headers: {
      Accept: manifestAccept,
      Authorization: authorization,
      "Content-Type": manifest.mediaType ?? "application/vnd.oci.image.manifest.v1+json",
    },
    body: JSON.stringify(manifest),
  });
  if (response.status !== 201 && response.status !== 202) {
    throw bootstrapError("private registry image publish", response.status);
  }
}

export interface RunnerImageBuilderBootstrapResult {
  reference: string;
  created: boolean;
}

/**
 * Copy the pinned public daemonless builder into the account-private registry.
 * This avoids local Docker and satisfies Cloudflare Containers' registry
 * policy, which requires non-Docker-Hub image registries to be configured.
 */
export async function bootstrapRunnerImageBuilder(
  env: WorkerEnvironment,
  dependencies: BootstrapDependencies = defaultDependencies,
): Promise<RunnerImageBuilderBootstrapResult> {
  const reference = runnerImageBuilderBootstrapReference(env);
  if (reference === undefined) {
    throw new Error("RUNNER_IMAGE_BUILDER_IMAGE_NAME must identify a Container registry image");
  }
  const repository = targetRepository(env);
  const credentials = await dependencies.createCredentials(env);
  const authorization = basicAuthorization(credentials);
  const initialResponse = await dependencies.fetch(
    `${sourceRegistry}/v2/${sourceRepository}/manifests/${sourceImageDigest()}`,
    { headers: { Accept: manifestAccept } },
  );
  if (!initialResponse.ok) {
    throw bootstrapError("Kaniko image download", initialResponse.status);
  }
  const parsedInitial = z.json().safeParse(await initialResponse.json());
  if (!parsedInitial.success) {
    throw bootstrapError("Kaniko image download");
  }
  const initial = parsedInitial.data;
  const parsedManifest = ociManifestSchema.safeParse(initial);
  let expectedManifestDigest: string;
  let manifest: OciManifest;
  if (parsedManifest.success) {
    expectedManifestDigest = sourceImageDigest();
    manifest = parsedManifest.data;
  } else {
    const selected = selectLinuxAmd64Manifest(initial);
    if (selected === undefined) {
      throw bootstrapError("Kaniko linux/amd64 image selection");
    }
    expectedManifestDigest = selected.digest;
    manifest = await sourceManifest(selected.digest, dependencies);
  }

  if (await targetManifestMatches(repository, expectedManifestDigest, authorization, dependencies)) {
    return { reference, created: false };
  }

  for (const descriptor of [manifest.config, ...manifest.layers]) {
    // eslint-disable-next-line no-await-in-loop -- avoid duplicate uploads and bound memory use.
    await copyBlob(repository, descriptor, authorization, dependencies);
  }
  await publishManifest(repository, manifest, authorization, dependencies);
  return { reference, created: true };
}
