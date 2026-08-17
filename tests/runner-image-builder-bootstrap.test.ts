import { describe, expect, it, vi } from "vite-plus/test";

import { bootstrapRunnerImageBuilder, selectLinuxAmd64Manifest } from "../src/runner-image-builder-bootstrap";
import { RUNNER_IMAGE_BUILDER_BOOTSTRAP_TAG } from "../src/runner-image";
import type { WorkerEnvironment } from "../src/environment";

const environment = {
  CLOUDFLARE_ACCOUNT_ID: "account-id",
  RUNNER_IMAGE_BUILDER_IMAGE_NAME: "runner-image-builder",
};
// SAFETY: bootstrap reads only these two bindings in these tests, and every call injects the credential provider.
const bootstrapEnvironment = environment as WorkerEnvironment;

const config = {
  mediaType: "application/vnd.oci.image.config.v1+json",
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  size: 12,
};
const layer = {
  mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
  digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  size: 24,
};

function uploadLocation(name: string): string {
  return `https://registry.cloudflare.com/v2/account-id/runner-image-builder/blobs/uploads/${name}`;
}

describe("private daemonless runner-image builder bootstrap", () => {
  it("selects only the linux/amd64 image from a public OCI index", () => {
    expect(
      selectLinuxAmd64Manifest({
        manifests: [
          { ...config, platform: { os: "linux", architecture: "arm64" } },
          { ...layer, platform: { os: "linux", architecture: "amd64" } },
        ],
      }),
    ).toEqual({ ...layer, platform: { os: "linux", architecture: "amd64" } });
    expect(selectLinuxAmd64Manifest({ manifests: [] })).toBeUndefined();
    expect(selectLinuxAmd64Manifest({ manifests: "not-an-array" })).toBeUndefined();
  });

  it("copies the pinned public Kaniko config and layers into the account registry", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (init?.method === "HEAD" && url.endsWith(`/manifests/${RUNNER_IMAGE_BUILDER_BOOTSTRAP_TAG}`)) {
        return new Response(null, { status: 404 });
      }
      if (url.includes("gcr.io/v2/kaniko-project/executor/manifests/") && init?.method === undefined) {
        if (url.includes("2562c4fe551399514277ffff7dcca9a3b1628c4ea38cb017d7286dc6ea52f4cd")) {
          return Response.json({
            manifests: [
              { ...layer, platform: { os: "linux", architecture: "arm64" } },
              {
                ...config,
                digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                platform: { os: "linux", architecture: "amd64" },
              },
            ],
          });
        }
        return Response.json({ schemaVersion: 2, config, layers: [layer] });
      }
      if (url.includes("gcr.io/v2/kaniko-project/executor/blobs/")) {
        return new Response("blob", { status: 200 });
      }
      if (init?.method === "HEAD" && url.includes("/blobs/")) {
        return new Response(null, { status: 404 });
      }
      if (init?.method === "POST" && url.endsWith("/blobs/uploads/")) {
        return new Response(null, { status: 202, headers: { Location: uploadLocation(String(requests.length)) } });
      }
      if (init?.method === "PUT" && url.includes("/blobs/uploads/")) {
        return new Response(null, { status: 201 });
      }
      if (init?.method === "PUT" && url.endsWith(`/manifests/${RUNNER_IMAGE_BUILDER_BOOTSTRAP_TAG}`)) {
        return new Response(null, { status: 201 });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    });

    const result = await bootstrapRunnerImageBuilder(bootstrapEnvironment, {
      fetch,
      createCredentials: async () => ({ username: "short-lived-user", password: "short-lived-password" }),
    });

    expect(result).toEqual({
      reference: `registry.cloudflare.com/account-id/runner-image-builder:${RUNNER_IMAGE_BUILDER_BOOTSTRAP_TAG}`,
      created: true,
    });
    expect(requests.map((request) => `${request.init?.method ?? "GET"} ${request.url}`)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("GET https://gcr.io/v2/kaniko-project/executor/manifests/"),
        expect.stringContaining("GET https://gcr.io/v2/kaniko-project/executor/blobs/"),
        `PUT https://registry.cloudflare.com/v2/account-id/runner-image-builder/manifests/${RUNNER_IMAGE_BUILDER_BOOTSTRAP_TAG}`,
      ]),
    );
    const sourceRequests = requests.filter((request) => request.url.startsWith("https://gcr.io/"));
    expect(sourceRequests.every((request) => new Headers(request.init?.headers).get("Authorization") === null)).toBe(
      true,
    );
    const privateRequests = requests.filter((request) => request.url.startsWith("https://registry.cloudflare.com/"));
    expect(
      privateRequests.every((request) => new Headers(request.init?.headers).get("Authorization")?.startsWith("Basic ")),
    ).toBe(true);
  });

  it("reuses only a private builder tag whose manifest digest matches the pinned source", async () => {
    const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://gcr.io/v2/kaniko-project/executor/manifests/")) {
        return Response.json({ schemaVersion: 2, config, layers: [layer] });
      }
      if (init?.method === "HEAD" && url.endsWith(`/manifests/${RUNNER_IMAGE_BUILDER_BOOTSTRAP_TAG}`)) {
        return new Response(null, {
          status: 200,
          headers: {
            "Docker-Content-Digest": "sha256:2562c4fe551399514277ffff7dcca9a3b1628c4ea38cb017d7286dc6ea52f4cd",
          },
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    });

    await expect(
      bootstrapRunnerImageBuilder(bootstrapEnvironment, {
        fetch,
        createCredentials: async () => ({ username: "short-lived-user", password: "short-lived-password" }),
      }),
    ).resolves.toMatchObject({ created: false });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the private registry refuses the bootstrap check", async () => {
    await expect(
      bootstrapRunnerImageBuilder(bootstrapEnvironment, {
        fetch: async (input, init) =>
          String(input).startsWith("https://gcr.io/v2/kaniko-project/executor/manifests/")
            ? Response.json({ schemaVersion: 2, config, layers: [layer] })
            : new Response(null, { status: init?.method === "HEAD" ? 401 : 500 }),
        createCredentials: async () => ({ username: "short-lived-user", password: "short-lived-password" }),
      }),
    ).rejects.toThrow("private registry image check returned 401");
  });
});
