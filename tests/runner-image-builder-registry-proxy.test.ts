import { describe, expect, it, vi } from "vite-plus/test";

import {
  dockerHubChallengeResponse,
  privateRegistryProxyRequest,
  privateRegistryRequestIsAllowed,
  privateRegistryUpstreamUrl,
  verifiedHttpsProxyRequest,
  RegistryAuthorizationCache,
} from "../src/runner-image-builder-registry-proxy";

describe("runner-image builder registry proxy", () => {
  it("limits Worker-issued credentials to the managed runner-image repository", () => {
    expect(privateRegistryRequestIsAllowed(new Request("http://registry.cloudflare.com/v2/"), "account/runner")).toBe(
      true,
    );
    expect(
      privateRegistryRequestIsAllowed(
        new Request("http://registry.cloudflare.com/v2/", { method: "POST" }),
        "account/runner",
      ),
    ).toBe(false);
    expect(
      privateRegistryRequestIsAllowed(
        new Request("http://registry.cloudflare.com/v2/account/runner/blobs/uploads/", { method: "POST" }),
        "account/runner",
      ),
    ).toBe(true);
    expect(
      privateRegistryRequestIsAllowed(
        new Request("http://registry.cloudflare.com/v2/account/other/manifests/latest"),
        "account/runner",
      ),
    ).toBe(false);
    expect(
      privateRegistryRequestIsAllowed(
        new Request("http://registry.cloudflare.com/v2/account/runner/manifests/latest", { method: "DELETE" }),
        "account/runner",
      ),
    ).toBe(false);
    expect(
      privateRegistryRequestIsAllowed(
        new Request("http://registry.cloudflare.com/v2/account/runner/blobs/uploads/?mount=sha256:abc", {
          method: "POST",
        }),
        "account/runner",
      ),
    ).toBe(false);
  });

  it("upgrades the intercepted in-platform hop to HTTPS without changing the registry path or query", () => {
    const upstream = privateRegistryUpstreamUrl(
      "http://registry.cloudflare.com/v2/account/runner/manifests/latest?mount=layer",
    );

    expect(upstream.toString()).toBe("https://registry.cloudflare.com/v2/account/runner/manifests/latest?mount=layer");
  });

  it("preserves registry credentials and the upload body while upgrading to HTTPS", async () => {
    const original = new Request("http://registry.cloudflare.com/v2/account/runner/blobs/uploads/", {
      method: "POST",
      headers: { Authorization: "Basic temporary-credential", "Content-Type": "application/octet-stream" },
      body: "layer bytes",
    });

    const upstream = privateRegistryProxyRequest(original, "Basic worker-issued-credential");

    expect(upstream.url).toBe("https://registry.cloudflare.com/v2/account/runner/blobs/uploads/");
    expect(upstream.method).toBe("POST");
    expect(upstream.headers.get("Authorization")).toBe("Basic worker-issued-credential");
    expect(upstream.headers.get("Content-Type")).toBe("application/octet-stream");
    await expect(upstream.text()).resolves.toBe("layer bytes");
  });

  it("upgrades a public-registry pull without adding private-registry credentials", () => {
    const original = new Request("http://index.docker.io/v2/library/ubuntu/manifests/latest?ns=docker.io", {
      headers: { Accept: "application/vnd.oci.image.manifest.v1+json" },
    });

    const upstream = verifiedHttpsProxyRequest(original);

    expect(upstream.url).toBe("https://index.docker.io/v2/library/ubuntu/manifests/latest?ns=docker.io");
    expect(upstream.headers.get("Accept")).toBe("application/vnd.oci.image.manifest.v1+json");
    expect(upstream.headers.get("Authorization")).toBeNull();
    expect(upstream.redirect).toBe("follow");
  });

  it("follows a manually intercepted signed layer redirect in the Worker", () => {
    const original = new Request("http://index.docker.io/v2/library/ubuntu/blobs/sha256:layer", {
      redirect: "manual",
    });

    expect(verifiedHttpsProxyRequest(original).redirect).toBe("follow");
  });

  it("rewrites only Docker Hub's token challenge for the encrypted in-platform hop", () => {
    const response = new Response(null, {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"',
      },
    });

    const rewritten = dockerHubChallengeResponse(response);

    expect(rewritten.headers.get("WWW-Authenticate")).toBe(
      'Bearer realm="http://auth.docker.io/token",service="registry.docker.io"',
    );
  });

  it("preserves an unrelated authentication challenge without cloning the response", () => {
    const response = new Response(null, {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="https://example.test/token"' },
    });

    expect(dockerHubChallengeResponse(response)).toBe(response);
  });

  it("shares one Worker-only credential across concurrent layer requests", async () => {
    const cache = new RegistryAuthorizationCache();
    const load = vi.fn<() => Promise<string>>(async () => "Basic shared-credential");

    await expect(Promise.all([cache.get(load), cache.get(load), cache.get(load)])).resolves.toEqual([
      "Basic shared-credential",
      "Basic shared-credential",
      "Basic shared-credential",
    ]);
    expect(load).toHaveBeenCalledOnce();
  });

  it("refreshes an expired Worker-only credential", async () => {
    const cache = new RegistryAuthorizationCache();
    let issued = 0;
    const load = vi.fn<() => Promise<string>>(async () => `Basic credential-${(issued += 1)}`);

    await expect(cache.get(load, 0)).resolves.toBe("Basic credential-1");
    await expect(cache.get(load, 14 * 60 * 1_000 - 1)).resolves.toBe("Basic credential-1");
    await expect(cache.get(load, 14 * 60 * 1_000)).resolves.toBe("Basic credential-2");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
