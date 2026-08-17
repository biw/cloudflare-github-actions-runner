import { describe, expect, it, vi } from "vite-plus/test";

import {
  hasValidOwnershipInspectionAuthorization,
  inspectRunnerResourceOwnership,
  recordRunnerResourceOwnership,
  validCloudflareResourceTagging,
  type RunnerResourceOwnershipEnvironment,
} from "../src/runner-resource-ownership";

const installationId = "11111111-1111-4111-8111-111111111111";
const accountId = "0123456789abcdef0123456789abcdef";
const environment: RunnerResourceOwnershipEnvironment = {
  CLOUDFLARE_ACCOUNT_ID: accountId,
  CLOUDFLARE_CONTAINERS_API_TOKEN: "account-owned-token",
  RUNNER_INSTALLATION_ID: installationId,
  RUNNER_RESOURCE_MANIFEST: JSON.stringify({
    version: 1,
    installationId,
    accountId,
    worker: { name: "runner-worker" },
    database: { id: "database-id", name: "runner-metrics" },
    bucket: { name: "runner-storage" },
  }),
};

interface CloudflareFixtureResult {
  id?: string;
  type?: string;
  etag?: string;
  tags?: Record<string, string>;
}

function cloudflareResponse(result: CloudflareFixtureResult | CloudflareFixtureResult[] | null, status = 200) {
  return Response.json({ success: status < 400, result, errors: [] }, { status });
}

describe("Worker-mediated runner resource ownership", () => {
  it("validates Tag Read access without exposing the account-owned token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(cloudflareResponse([]));

    await expect(validCloudflareResourceTagging(environment, { fetch })).resolves.toBe(true);
    expect(fetch.mock.calls[0]?.[0]).toBe(`https://api.cloudflare.com/client/v4/accounts/${accountId}/tags/keys`);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer account-owned-token");

    fetch.mockResolvedValueOnce(cloudflareResponse(null, 403));
    await expect(validCloudflareResourceTagging(environment, { fetch })).resolves.toBe(false);
  });

  it("GET-merges-PUTs tags for exactly the three manifest resources with ETag protection", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "PUT") return cloudflareResponse({});
      const id = url.searchParams.get("id");
      const type = url.searchParams.get("type") ?? "";
      return cloudflareResponse(
        id === "runner-worker" ? [{ id, type, etag: "v1:existing", tags: { team: "platform" } }] : [],
      );
    });

    await expect(recordRunnerResourceOwnership(environment, { fetch })).resolves.toEqual({
      installationId,
      resources: [
        { type: "worker", id: "runner-worker" },
        { type: "d1_database", id: "database-id" },
        { type: "r2_bucket", id: "runner-storage" },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(6);
    const workerPut = fetch.mock.calls.find(
      ([, init]) => init?.method === "PUT" && String(init.body).includes('"resource_id":"runner-worker"'),
    );
    expect(new Headers(workerPut?.[1]?.headers).get("If-Match")).toBe("v1:existing");
    expect(workerPut?.[1]).toMatchObject({
      body: JSON.stringify({
        resource_type: "worker",
        resource_id: "runner-worker",
        tags: {
          team: "platform",
          "managed-by": "cloudflare-github-actions-runner",
          "runner-installation-id": installationId,
        },
      }),
    });
    const untaggedPut = fetch.mock.calls.find(
      ([, init]) => init?.method === "PUT" && String(init.body).includes('"resource_id":"database-id"'),
    );
    expect(new Headers(untaggedPut?.[1]?.headers).has("If-Match")).toBe(false);
  });

  it("returns only manifest resources even if the installation query includes an extra resource", async () => {
    const tags = {
      "managed-by": "cloudflare-github-actions-runner",
      "runner-installation-id": installationId,
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      cloudflareResponse([
        { id: "runner-worker", type: "worker", etag: "v1:1", tags },
        { id: "database-id", type: "d1_database", etag: "v1:2", tags },
        { id: "runner-storage", type: "r2_bucket", etag: "v1:3", tags },
        { id: "customer-worker", type: "worker", etag: "v1:4", tags },
      ]),
    );

    await expect(inspectRunnerResourceOwnership(environment, { fetch })).resolves.toEqual([
      { id: "runner-worker", type: "worker", etag: "v1:1", tags },
      { id: "database-id", type: "d1_database", etag: "v1:2", tags },
      { id: "runner-storage", type: "r2_bucket", etag: "v1:3", tags },
    ]);
  });

  it("requires the installation capability and a matching manifest before inspecting ownership", async () => {
    expect(
      hasValidOwnershipInspectionAuthorization(
        new Request("https://runner.example/v1/setup/resource-ownership", {
          headers: { "X-Runner-Installation-Id": installationId },
        }),
        environment,
      ),
    ).toBe(true);
    expect(
      hasValidOwnershipInspectionAuthorization(
        new Request("https://runner.example/v1/setup/resource-ownership"),
        environment,
      ),
    ).toBe(false);

    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      inspectRunnerResourceOwnership({ ...environment, RUNNER_INSTALLATION_ID: crypto.randomUUID() }, { fetch }),
    ).rejects.toThrow("manifest is missing or does not match");
    expect(fetch).not.toHaveBeenCalled();
  });
});
