import { describe, expect, it } from "vite-plus/test";
import { generateKeyPairSync } from "node:crypto";

import {
  cloudflareContainersTokenIdentity,
  hasValidSetupAuthorization,
  validateRunnerSetupTokens,
  type RunnerSetupValidationEnvironment,
} from "../src/setup-validation";

const environment: RunnerSetupValidationEnvironment = {
  CLOUDFLARE_ACCOUNT_ID: "account-1",
  CLOUDFLARE_CONTAINERS_API_TOKEN: "cloudflare-token",
  CUSTOM_RUNNER_APPLICATION: "runner-custom",
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({
      type: "pkcs8",
      format: "pem",
    })
    .toString(),
  GITHUB_APP_WEBHOOK_SECRET: "webhook-secret",
  RESOURCE_TRACE_SIGNING_KEY: "trace-signing-key",
  RUNNER_CACHE_SIGNING_KEY: "cache-signing-key",
  RUNNER_SETUP_VALIDATION_TOKEN: "setup-token",
};

describe("runner setup token validation", () => {
  it("exposes only the account-owned Containers token ID needed for revocation", async () => {
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.cloudflare.com/client/v4/accounts/account-1/tokens/verify");
      expect(init?.headers).toEqual({ Authorization: "Bearer cloudflare-token" });
      return Response.json({
        success: true,
        result: { id: "0123456789abcdef0123456789abcdef", status: "active" },
      });
    };

    await expect(cloudflareContainersTokenIdentity(environment, { fetch })).resolves.toEqual({
      id: "0123456789abcdef0123456789abcdef",
      status: "active",
    });
  });

  it("validates existing Cloudflare and GitHub App credentials without exposing them", async () => {
    const requests: (RequestInfo | URL)[] = [];
    const result = await validateRunnerSetupTokens(environment, {
      fetch: async (input) => {
        requests.push(input);
        if (String(input).includes("/registries/registry.cloudflare.com/credentials")) {
          return Response.json({ success: true, result: { username: "v1", password: "temporary" } });
        }
        if (String(input).includes("api.cloudflare.com")) {
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        if (String(input).endsWith("/app")) {
          return Response.json({ id: 123, slug: "runner-app" });
        }
        return Response.json([]);
      },
    });

    expect(result).toEqual({
      cloudflareContainersToken: true,
      cloudflareRegistryPush: true,
      cloudflareResourceTagging: true,
      githubApp: true,
      githubAppWebhookSecret: true,
      resourceTraceSigningKey: true,
      runnerCacheSigningKey: true,
    });
    expect(requests.map(String)).toEqual([
      "https://api.cloudflare.com/client/v4/accounts/account-1/containers/applications",
      "https://api.cloudflare.com/client/v4/accounts/account-1/containers/registries/registry.cloudflare.com/credentials",
      "https://api.cloudflare.com/client/v4/accounts/account-1/tags/keys",
      "https://api.github.com/app",
      "https://api.github.com/app/installations?per_page=100",
    ]);
  });

  it("marks absent or rejected credentials as unusable", async () => {
    const result = await validateRunnerSetupTokens(
      {
        ...environment,
        CLOUDFLARE_CONTAINERS_API_TOKEN: "",
        GITHUB_APP_PRIVATE_KEY: "",
        GITHUB_APP_WEBHOOK_SECRET: "",
      },
      { fetch: async () => new Response(null, { status: 500 }) },
    );

    expect(result).toEqual({
      cloudflareContainersToken: false,
      cloudflareRegistryPush: false,
      cloudflareResourceTagging: false,
      githubApp: false,
      githubAppWebhookSecret: false,
      resourceTraceSigningKey: true,
      runnerCacheSigningKey: true,
    });
  });

  it("requires the generated setup validation token", () => {
    expect(hasValidSetupAuthorization(new Request("https://runner.example/v1/setup/validate"), environment)).toBe(
      false,
    );
    expect(
      hasValidSetupAuthorization(
        new Request("https://runner.example/v1/setup/validate", {
          headers: { Authorization: "Bearer setup-token" },
        }),
        environment,
      ),
    ).toBe(true);
  });
});
