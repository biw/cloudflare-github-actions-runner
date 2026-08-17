import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  githubAppStatus,
  githubInstallationAccessToken,
  githubRepositoryArchiveAvailable,
  githubRepositoryArchive,
  githubRepositoryArchiveWithMetadata,
  githubInstallationFromWebhook,
  githubTokenForRunner,
  githubWorkflowRunCacheScope,
  hasGitHubAppWebhookSecret,
  removeGitHubAppInstallations,
} from "../src/github-app";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({
    type: "pkcs8",
    format: "pem",
  })
  .toString();
const pkcs1PrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({
    type: "pkcs1",
    format: "pem",
  })
  .toString();
const environment = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: privateKey,
  GITHUB_APP_WEBHOOK_SECRET: "app-webhook-secret",
};

describe("GitHub App authentication", () => {
  it("removes every App installation before its private key is discarded", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json([
          { id: 42, account: { login: "ahoylabs", type: "Organization" }, repository_selection: "all" },
          { id: 84, account: { login: "biw", type: "User" }, repository_selection: "all" },
        ]),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));

    await expect(removeGitHubAppInstallations(environment, { fetch, now: () => 1_700_000_000_000 })).resolves.toEqual([
      { id: 42, account: "ahoylabs" },
      { id: 84, account: "biw" },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/app/installations/42",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/app/installations/84",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("exchanges a signed App JWT for an installation access token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ token: "installation-token" }));

    await expect(githubInstallationAccessToken(environment, 42, { fetch, now: () => 1_700_000_000_000 })).resolves.toBe(
      "installation-token",
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/app/installations/42/access_tokens",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Bearer ey/u) }),
      }),
    );
  });

  it("accepts GitHub's PKCS#1 RSA private-key format", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ token: "installation-token" }));

    await expect(
      githubInstallationAccessToken({ ...environment, GITHUB_APP_PRIVATE_KEY: pkcs1PrivateKey }, 42, {
        fetch,
        now: () => 1_700_000_000_000,
      }),
    ).resolves.toBe("installation-token");
  });

  it("reports App installations without exposing credentials", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          id: 123,
          slug: "cloudflare-actions-runner",
          owner: { login: "ahoylabs", type: "Organization" },
        }),
      )
      .mockResolvedValueOnce(
        Response.json([
          {
            id: 42,
            account: { login: "biw", type: "User" },
            repository_selection: "all",
          },
        ]),
      )
      .mockResolvedValueOnce(Response.json({ token: "installation-token", permissions: { actions: "read" } }));

    await expect(githubAppStatus(environment, { fetch, now: () => 1_700_000_000_000 })).resolves.toEqual({
      configured: true,
      valid: true,
      id: 123,
      slug: "cloudflare-actions-runner",
      owner: { login: "ahoylabs", type: "Organization" },
      events: [],
      installations: [
        {
          id: 42,
          account: "biw",
          accountType: "User",
          repositorySelection: "all",
          actionsRead: true,
          contentsRead: false,
          checksWrite: false,
        },
      ],
    });
  });

  it("reports the write permissions required for JIT runners and eligibility Checks", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ id: 123, slug: "cloudflare-actions-runner", events: [] }))
      .mockResolvedValueOnce(
        Response.json([{ id: 42, account: { login: "biw", type: "User" }, repository_selection: "all" }]),
      )
      .mockResolvedValueOnce(
        Response.json({ token: "installation-token", permissions: { administration: "write", checks: "write" } }),
      );

    const status = await githubAppStatus(environment, { fetch, now: () => 1_700_000_000_000 });

    expect(status.installations[0]).toMatchObject({ administrationWrite: true, checksWrite: true });
  });

  it("streams the source archive with a short-lived installation credential and falls back only for public sources", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ id: 42 }))
      .mockResolvedValueOnce(Response.json({ token: "installation-token", permissions: { contents: "read" } }))
      .mockResolvedValueOnce(new Response("archive"));

    const archive = await githubRepositoryArchive(environment, { owner: "biw", repository: "runner" }, "main", {
      fetch,
      now: () => 1_700_000_000_000,
    });
    await expect(new Response(archive).text()).resolves.toBe("archive");
    expect(fetch.mock.calls[2]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: "Bearer installation-token" }),
    });

    const publicFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response("public-archive"));
    const publicArchive = await githubRepositoryArchive(environment, { owner: "biw", repository: "runner" }, "main", {
      fetch: publicFetch,
      now: () => 1_700_000_000_000,
    });
    await expect(new Response(publicArchive).text()).resolves.toBe("public-archive");
    expect(publicFetch).toHaveBeenCalledTimes(2);
    expect(publicFetch.mock.calls[1]?.[1]).toMatchObject({
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "cloudflare-github-actions-runner",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  });

  it("checks runner-image source availability without retaining the archive stream", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ id: 42 }))
      .mockResolvedValueOnce(Response.json({ token: "installation-token", permissions: { contents: "read" } }))
      .mockResolvedValueOnce(new Response("archive"));

    await expect(
      githubRepositoryArchiveAvailable(environment, { owner: "biw", repository: "runner" }, "main", {
        fetch,
        now: () => 1_700_000_000_000,
      }),
    ).resolves.toBe(true);

    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("keeps a GitHub archive as a stream for the R2 hand-off", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ id: 42 }))
      .mockResolvedValueOnce(Response.json({ token: "installation-token", permissions: { contents: "read" } }))
      .mockResolvedValueOnce(new Response("archive", { headers: { "Content-Length": "7" } }));

    await expect(
      githubRepositoryArchiveWithMetadata(environment, { owner: "biw", repository: "runner" }, "main", {
        fetch,
        now: () => 1_700_000_000_000,
      }),
    ).resolves.toMatchObject({ body: expect.any(ReadableStream) });
  });

  it("buffers an archive when GitHub omits Content-Length so R2 receives a known length", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ id: 42 }))
      .mockResolvedValueOnce(Response.json({ token: "installation-token", permissions: { contents: "read" } }))
      .mockResolvedValueOnce(new Response("archive"));

    const archive = await githubRepositoryArchiveWithMetadata(
      environment,
      { owner: "biw", repository: "runner" },
      "main",
      { fetch, now: () => 1_700_000_000_000 },
    );

    expect(archive).toMatchObject({ body: expect.any(ArrayBuffer) });
    await expect(new Response(archive?.body).text()).resolves.toBe("archive");
  });

  it("uses an App installation token and falls back only for legacy deliveries", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ token: "installation-token" }));
    const legacy = vi
      .fn<(target: { owner: string; repository: string }) => Promise<string>>()
      .mockResolvedValue("legacy-token");

    await expect(
      githubTokenForRunner(environment, { owner: "biw", repository: "runner" }, 42, legacy, {
        fetch,
        now: () => 1_700_000_000_000,
      }),
    ).resolves.toBe("installation-token");
    await expect(githubTokenForRunner(environment, { owner: "biw", repository: "runner" }, null, legacy)).resolves.toBe(
      "legacy-token",
    );
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("extracts installation IDs and requires an App webhook secret", () => {
    expect(githubInstallationFromWebhook(JSON.stringify({ installation: { id: 42 } }))).toBe(42);
    expect(githubInstallationFromWebhook("{}")).toBeUndefined();
    expect(hasGitHubAppWebhookSecret(environment)).toBe(true);
    expect(hasGitHubAppWebhookSecret({ GITHUB_APP_WEBHOOK_SECRET: "" })).toBe(false);
  });

  it("gives pull requests an isolated merge-ref cache with a default-branch fallback", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        event: "pull_request",
        head_branch: "feature/cache",
        pull_requests: [{ number: 42 }],
      }),
    );

    await expect(
      githubWorkflowRunCacheScope({ owner: "biw", repository: "runner" }, 123, "main", "installation-token", {
        fetch,
        now: () => 1_700_000_000_000,
      }),
    ).resolves.toEqual({
      scope: "refs/pull/42/merge",
      fallbackScope: "refs/heads/main",
      writeAllowed: true,
    });
  });

  it("does not let pull_request_target runs write to the shared cache", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        event: "pull_request_target",
        head_branch: "main",
        pull_requests: [{ number: 42 }],
      }),
    );

    await expect(
      githubWorkflowRunCacheScope({ owner: "biw", repository: "runner" }, 123, "main", "installation-token", {
        fetch,
        now: () => 1_700_000_000_000,
      }),
    ).resolves.toEqual({
      scope: "refs/heads/main",
      writeAllowed: false,
    });
  });

  it("does not allow a failed workflow-run lookup to write a shared cache", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 404 }));

    await expect(
      githubWorkflowRunCacheScope({ owner: "biw", repository: "runner" }, 123, "main", "installation-token", {
        fetch,
        now: () => 1_700_000_000_000,
      }),
    ).resolves.toEqual({ scope: "refs/heads/main", writeAllowed: false });
  });
});
