import { describe, expect, it, vi } from "vite-plus/test";

import {
  cloudflareContainersTokenTemplateUrl,
  cloudflareWorkflowInstanceUrl,
  collapseCloudflareAccountCandidates,
  deploymentProgressFromOutput,
  existingWorkerTokenStatusMessages,
  extractWorkerBaseUrl,
  formatSetupStepDuration,
  generateResourceTraceSigningKey,
  generateWebhookSecret,
  githubAppCanServeRunnerOwner,
  githubAppManifest,
  githubAppManifestRegistrationUrl,
  githubAppSetupSummary,
  githubOwnerLabel,
  githubRunnerOwnerFromWorkerSettings,
  legacyGitHubOwnerFromWorkerSettings,
  githubOwnerNames,
  githubRunnerTokenSecretName,
  hasValidRunnerSetupTokenStatus,
  hasSuperAdministratorRole,
  inspectRunnerPoolSecrets,
  normalizeWorkerBaseUrl,
  orderedGitHubRunnerOwners,
  parseCloudflareAccounts,
  parseCloudflareIdentity,
  parseGitHubAccounts,
  parseGitHubAppOwners,
  parseGitHubRepositories,
  parseGitHubAppManifestConversion,
  parseWorkerSecretNames,
  parseWranglerAuthProfiles,
  promptForRunnerCacheConfiguration,
  remoteRunnerImageBuildFailure,
  remoteRunnerImageBuildProgressMessage,
  parseRunnerSetupTokenStatus,
  readCustomRunnerApplication,
  readRepositorySettings,
  retryRemoteRunnerImageBuild,
  retryWorkerTokenValidation,
  runnerPoolSummary,
  shouldCreateInitialGitHubApp,
  waitForRemoteRunnerImageBuild,
  waitForWorkerHealthCheck,
  waitForWorkerSetupAuthorization,
  waitForWorkerTokenValidation,
  validRunnerCacheBucketName,
  validRunnerCacheMaximumGigabytes,
  WorkerTokenValidationError,
  WorkerHealthCheckError,
} from "../scripts/setup.ts";

describe("interactive setup helpers", () => {
  it("reads deployment phases without exposing unrelated Wrangler output", () => {
    expect(deploymentProgressFromOutput("CLOUDFLARE_RUNNER_SETUP_PHASE:Preparing Worker configuration")).toBe(
      "Preparing Worker configuration",
    );
    expect(deploymentProgressFromOutput("Total Upload: 123 KiB")).toBeUndefined();
    expect(deploymentProgressFromOutput("CLOUDFLARE_RUNNER_SETUP_PHASE:")).toBeUndefined();
  });

  it("generates a 256-bit hexadecimal webhook secret", () => {
    const first = generateWebhookSecret();
    const second = generateWebhookSecret();

    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).not.toBe(second);
  });

  it("generates a high-entropy runner resource-trace signing key", () => {
    expect(generateResourceTraceSigningKey()).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("formats completed setup-step durations for terminal output", () => {
    expect(formatSetupStepDuration(1)).toBe("1ms");
    expect(formatSetupStepDuration(1_250)).toBe("1.3s");
    expect(formatSetupStepDuration(61_900)).toBe("1m 1s");
  });

  it("validates setup-time R2 cache inputs", () => {
    expect(validRunnerCacheBucketName("cloudflare-github-actions-runner-cache")).toBe(true);
    expect(validRunnerCacheBucketName("Cloudflare Cache")).toBe(false);
    expect(validRunnerCacheMaximumGigabytes("100")).toBe(true);
    expect(validRunnerCacheMaximumGigabytes("0")).toBe(false);
    expect(validRunnerCacheMaximumGigabytes("100.5")).toBe(false);
  });

  it("asks for one shared R2 storage bucket whether dependency caching is enabled or disabled", async () => {
    const confirmPrompt = vi
      .fn<(options: { message: string }) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const inputPrompt = vi
      .fn<(options: { message: string }) => Promise<string>>()
      .mockResolvedValueOnce("team-runner-storage")
      .mockResolvedValueOnce("team-runner-storage")
      .mockResolvedValueOnce("250");
    const prompts = { confirm: confirmPrompt, input: inputPrompt };

    await expect(promptForRunnerCacheConfiguration(prompts)).resolves.toEqual({
      RUNNER_CACHE_ENABLED: "false",
      RUNNER_CACHE_BUCKET_NAME: "team-runner-storage",
    });
    await expect(promptForRunnerCacheConfiguration(prompts)).resolves.toEqual({
      RUNNER_CACHE_ENABLED: "true",
      RUNNER_CACHE_BUCKET_NAME: "team-runner-storage",
      RUNNER_CACHE_MAX_SIZE_GB: "250",
    });
    expect(inputPrompt.mock.calls.filter(([options]) => options.message.includes("storage bucket"))).toHaveLength(2);
  });

  it("reads the target repository from Wrangler configuration", () => {
    expect(
      readRepositorySettings(`{
        "vars": {
          "GITHUB_OWNER": "octo-org",
          "GITHUB_REPOSITORY": "runner-poc",
        },
      }`),
    ).toEqual({ owner: "octo-org", repository: "runner-poc" });

    expect(
      readCustomRunnerApplication(`{
        "vars": {
          "CUSTOM_RUNNER_APPLICATION": "runner-poc-custom",
        },
      }`),
    ).toBe("runner-poc-custom");
  });

  it("reads the Cloudflare accounts reported by Wrangler", () => {
    const identity = JSON.stringify({
      loggedIn: true,
      email: "developer@example.com",
      accounts: [
        { id: "account-1", name: "First account", ignored: true },
        { id: "account-2", name: "Second account" },
      ],
    });
    const accounts = [
      { id: "account-1", name: "First account" },
      { id: "account-2", name: "Second account" },
    ];

    expect(parseCloudflareIdentity(identity)).toEqual({ email: "developer@example.com", accounts });
    expect(parseCloudflareAccounts(identity)).toEqual(accounts);

    expect(() => parseCloudflareAccounts("not json")).toThrow(/invalid Cloudflare account information/u);
    expect(() => parseCloudflareAccounts('{"loggedIn":false,"accounts":[]}')).toThrow(/not authenticated/u);
  });

  it("lists usable Wrangler profiles without depending on table borders or colors", () => {
    const output = `\u001B[33m│ Profile  │ Bound Directories │\u001B[0m
│ default  │ -                 │
│ personal │ /projects         │
│ work     │ /work             │`;
    expect(parseWranglerAuthProfiles(output)).toEqual(["default", "personal", "work"]);
  });

  it("puts the current GitHub user first and sorts organizations and repositories", () => {
    const accounts = parseGitHubAccounts(
      JSON.stringify({ login: "ben", name: "Ben Williams" }),
      JSON.stringify([
        [
          { login: "zebra", name: "Zebra" },
          { login: "acme", name: "Acme" },
        ],
      ]),
    );
    expect(accounts).toEqual({
      personal: { login: "ben", name: "Ben Williams" },
      organizations: [
        { login: "acme", name: "Acme" },
        { login: "zebra", name: "Zebra" },
      ],
    });
    expect(
      parseGitHubRepositories(
        JSON.stringify([
          [
            { name: "z", full_name: "acme/z", owner: { login: "acme" } },
            { name: "a", full_name: "acme/a", owner: { login: "acme" } },
            { name: "ignored", full_name: "other/ignored", owner: { login: "other" } },
          ],
        ]),
        "acme",
      ),
    ).toEqual([
      { name: "a", fullName: "acme/a" },
      { name: "z", fullName: "acme/z" },
    ]);
    expect(githubOwnerNames(accounts)).toEqual(["ben", "acme", "zebra"]);
  });

  it("lists the personal account and active organization owners as GitHub App owners", () => {
    const owners = parseGitHubAppOwners(
      JSON.stringify({ login: "ben", name: "Ben Williams" }),
      JSON.stringify([
        [
          { state: "active", role: "admin", organization: { login: "zebra", name: "Zebra" } },
          { state: "active", role: "member", organization: { login: "ignored-member" } },
          { state: "pending", role: "admin", organization: { login: "ignored-pending" } },
          { state: "active", role: "admin", organization: { login: "acme", name: "Acme" } },
        ],
      ]),
    );

    expect(owners).toEqual([
      { type: "personal", login: "ben", name: "Ben Williams" },
      { type: "organization", login: "acme", name: "Acme" },
      { type: "organization", login: "zebra", name: "Zebra" },
    ]);
  });

  it("uses a deterministic Cloudflare secret name for a GitHub owner PAT", () => {
    expect(githubRunnerTokenSecretName("BIW")).toBe(githubRunnerTokenSecretName("biw"));
    expect(githubRunnerTokenSecretName("biw")).toMatch(/^GITHUB_RUNNER_TOKEN_[0-9a-f]{64}$/u);
  });

  it("detects a GitHub App-configured runner pool from Worker secret metadata", () => {
    const secretNames = parseWorkerSecretNames(
      JSON.stringify([
        { name: "CLOUDFLARE_CONTAINERS_API_TOKEN" },
        { name: "GITHUB_APP_ID" },
        { name: "GITHUB_APP_PRIVATE_KEY" },
        { name: "GITHUB_APP_WEBHOOK_SECRET" },
        { name: "RESOURCE_TRACE_SIGNING_KEY" },
        { name: "RUNNER_CACHE_SIGNING_KEY" },
      ]),
    );

    const runnerPool = inspectRunnerPoolSecrets(secretNames);

    expect(runnerPool).toEqual({
      configured: true,
      githubAppConfigured: true,
      githubRunnerOwnerSecretConfigured: false,
      legacyPatConfigured: false,
    });
    expect(runnerPoolSummary({ workerFound: true, ...runnerPool })).toBe("GitHub App configured");
  });

  it("recognizes the atomic GitHub-owner secret migration", () => {
    expect(inspectRunnerPoolSecrets(new Set(["GITHUB_RUNNER_OWNER"]))).toMatchObject({
      githubRunnerOwnerSecretConfigured: true,
    });
  });

  it("prefers the public runner-owner mirror while retaining legacy pools", () => {
    expect(
      githubRunnerOwnerFromWorkerSettings({
        bindings: [
          { name: "GITHUB_RUNNER_OWNER", text: "legacy-owner" },
          { name: "RUNNER_POOL_GITHUB_OWNER", text: "current-owner" },
        ],
      }),
    ).toBe("current-owner");
    expect(
      githubRunnerOwnerFromWorkerSettings({ bindings: [{ name: "GITHUB_RUNNER_OWNER", text: "legacy-owner" }] }),
    ).toBe("legacy-owner");
  });

  it("does not mistake an arbitrary Worker for a configured runner pool", () => {
    const runnerPool = inspectRunnerPoolSecrets(parseWorkerSecretNames(JSON.stringify([{ name: "UNRELATED_SECRET" }])));

    expect(runnerPool.configured).toBe(false);
    expect(runnerPoolSummary({ workerFound: false, ...runnerPool })).toBe("GitHub App not configured");
    expect(() => parseWorkerSecretNames("{}")).toThrow(/invalid Worker secret information/u);
  });

  it("collapses duplicate Wrangler profiles for the same Cloudflare account", () => {
    const account = { id: "account-id", name: "Ahoy Labs" };
    const candidates = collapseCloudflareAccountCandidates([
      {
        account,
        profile: "default",
        containersEnabled: true,
        superAdministrator: true,
        runnerPool: { workerFound: true, githubAppConfigured: true },
      },
      {
        account,
        profile: "work",
        containersEnabled: true,
        superAdministrator: true,
        runnerPool: { workerFound: true, githubAppConfigured: true },
      },
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].profile).toBe("work");
  });

  it("makes the configured GitHub owner the default setup choice", () => {
    const owners = [
      { type: "personal", login: "biw" },
      { type: "organization", login: "ahoylabs", name: "Ahoy Labs" },
    ];

    expect(githubRunnerOwnerFromWorkerSettings({ bindings: [{ name: "GITHUB_RUNNER_OWNER", text: "ahoylabs" }] })).toBe(
      "ahoylabs",
    );
    expect(legacyGitHubOwnerFromWorkerSettings({ bindings: [{ name: "LEGACY_GITHUB_OWNER", text: "biw" }] })).toBe(
      "biw",
    );
    expect(orderedGitHubRunnerOwners(owners, "AhoyLabs")).toEqual([
      { owner: owners[1], previouslyConfigured: true },
      { owner: owners[0], previouslyConfigured: false },
    ]);
    expect(githubOwnerLabel(owners[0], { previouslyConfigured: true })).toBe("personal: biw (previously configured)");
    expect(githubOwnerLabel(owners[1])).toBe("org: Ahoy Labs (ahoylabs)");
  });

  it("recognizes the Super Administrator role in Wrangler membership output", () => {
    expect(
      hasSuperAdministratorRole(`
        Membership roles in "Example account":
        - Super Administrator - All Privileges
      `),
    ).toBe(true);
    expect(hasSuperAdministratorRole("- Administrator")).toBe(false);
  });

  it("creates a prefilled account-owned Containers Write and Tag Read/Write API-token URL", () => {
    const url = new URL(cloudflareContainersTokenTemplateUrl());

    expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/");
    expect(url.searchParams.get("to")).toBe("/:account/api-tokens");
    expect(url.searchParams.get("accountId")).toBeNull();
    expect(url.searchParams.get("zoneId")).toBeNull();
    expect(url.searchParams.get("name")).toBe("Cloudflare GitHub Actions Runner");
    expect(JSON.parse(url.searchParams.get("permissionGroupKeys") ?? "")).toEqual([
      { key: "containers", type: "edit" },
      { key: "tag", type: "read" },
      { key: "tag", type: "edit" },
    ]);
  });

  it("creates and parses the least-privilege GitHub App manifest", () => {
    const manifest = githubAppManifest(
      "Cloudflare Runner",
      "https://runner.example.workers.dev",
      "http://127.0.0.1/callback",
    );

    expect(manifest).toMatchObject({
      public: true,
      default_events: ["workflow_job", "push"],
      hook_attributes: { url: "https://runner.example.workers.dev/webhooks/github" },
    });
    expect(manifest.default_permissions).toEqual({
      actions: "read",
      administration: "write",
      checks: "write",
      contents: "read",
    });
    expect(
      parseGitHubAppManifestConversion(
        JSON.stringify({ id: 42, pem: "private-key", webhook_secret: "webhook-secret", slug: "cloudflare-runner" }),
      ),
    ).toEqual({ id: "42", privateKey: "private-key", webhookSecret: "webhook-secret", slug: "cloudflare-runner" });
  });

  it("does not accept an existing installation until Checks Write is granted", () => {
    const owner = { type: "organization", login: "ahoylabs", name: "Ahoy Labs" };
    const status = {
      events: ["push", "workflow_job"],
      installations: [
        {
          account: "ahoylabs",
          repositorySelection: "all",
          actionsRead: true,
          contentsRead: true,
          administrationWrite: true,
          checksWrite: false,
        },
      ],
    };

    expect(githubAppCanServeRunnerOwner(status, owner)).toBe(false);
    status.installations[0].checksWrite = true;
    expect(githubAppCanServeRunnerOwner(status, owner)).toBe(true);
  });

  it("prints the validated GitHub App slug in the setup summary", () => {
    expect(githubAppSetupSummary("cloudflare-actions-runner-93e0afe3")).toBe(
      "GitHub App: cloudflare-actions-runner-93e0afe3",
    );
  });

  it("shows safe, useful progress and failures from a remote runner-image build", () => {
    expect(remoteRunnerImageBuildProgressMessage({ status: "queued" })).toBe(
      "Waiting for Cloudflare to schedule the image build",
    );
    expect(remoteRunnerImageBuildProgressMessage({ progress: { phase: "bootstrapping-builder" } })).toBe(
      "Bootstrapping Cloudflare's private daemonless image builder",
    );
    expect(remoteRunnerImageBuildProgressMessage({ progress: { phase: "building-and-pushing" } })).toBe(
      "Building and pushing the runner image to Cloudflare's private registry",
    );
    expect(
      remoteRunnerImageBuildProgressMessage({
        progress: { phase: "rolling-out", rollout: { processedApplications: 3, totalApplications: 6 } },
      }),
    ).toBe("Rolling runner profiles to the new image (3/6 profiles checked)");
    expect(
      remoteRunnerImageBuildFailure({
        status: "errored",
        error: "Could not download biw/cloudflare-github-actions-runner@main. Grant the GitHub App Contents: Read.",
      }),
    ).toBe(
      "Cloudflare could not build the runner image: Could not download biw/cloudflare-github-actions-runner@main. Grant the GitHub App Contents: Read.",
    );
    expect(remoteRunnerImageBuildFailure({ status: "errored" })).toMatch(/check Worker logs/u);
  });

  it("links directly to the Cloudflare runner-image Workflow instance", () => {
    expect(
      cloudflareWorkflowInstanceUrl(
        "2381cdb8d24daabc78a0454493e0afe3",
        "cloudflare-github-actions-runner-image-build",
        "setup-e2639640-869d-43a8-a652-9b409f1f49ce",
      ),
    ).toBe(
      "https://dash.cloudflare.com/2381cdb8d24daabc78a0454493e0afe3/workers/workflows/cloudflare-github-actions-runner-image-build/instance/setup-e2639640-869d-43a8-a652-9b409f1f49ce",
    );
    expect(cloudflareWorkflowInstanceUrl("account", "workflow/name", "instance id")).toBe(
      "https://dash.cloudflare.com/account/workers/workflows/workflow%2Fname/instance/instance%20id",
    );
  });

  it("keeps polling a healthy remote image build after a transient network failure", async () => {
    let attempts = 0;
    const result = { imageReference: "registry.cloudflare.com/account/runner:runner-0123456789abcdef01234567" };

    await expect(
      waitForRemoteRunnerImageBuild("https://runner.example.workers.dev", "setup-token", "workflow-id", {
        fetcher: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new TypeError("fetch failed");
          }
          return new Response(JSON.stringify({ status: "complete", result }));
        },
        pollDelayMs: 0,
      }),
    ).resolves.toEqual(result);
    expect(attempts).toBe(2);
  });

  it("reports a persistent remote image-build polling outage", async () => {
    let attempts = 0;

    await expect(
      waitForRemoteRunnerImageBuild("https://runner.example.workers.dev", "setup-token", "workflow-id", {
        fetcher: async () => {
          attempts += 1;
          throw new TypeError("fetch failed");
        },
        maximumConsecutivePollFailures: 3,
        pollDelayMs: 0,
      }),
    ).rejects.toThrow("after 3 consecutive network failures");
    expect(attempts).toBe(3);
  });

  it("offers to retry a failed remote image build and starts a fresh attempt", async () => {
    const build = vi
      .fn<() => Promise<{ imageReference: string }>>()
      .mockRejectedValueOnce(new Error("first Workflow failed"))
      .mockRejectedValueOnce(new Error("second Workflow failed"))
      .mockResolvedValueOnce({ imageReference: "registry.cloudflare.com/account/runner:recovered" });
    const confirmRetry = vi
      .fn<(options: { message: string; default: boolean }) => Promise<boolean>>()
      .mockResolvedValue(true);
    const reportFailure = vi.fn<(message: string) => void>();

    await expect(retryRemoteRunnerImageBuild(build, { confirmRetry, reportFailure })).resolves.toEqual({
      imageReference: "registry.cloudflare.com/account/runner:recovered",
    });
    expect(build).toHaveBeenCalledTimes(3);
    expect(confirmRetry).toHaveBeenCalledTimes(2);
    expect(confirmRetry).toHaveBeenCalledWith({
      message: "Try building the shared runner image again?",
      default: true,
    });
    expect(reportFailure.mock.calls).toEqual([["\nfirst Workflow failed"], ["\nsecond Workflow failed"]]);
  });

  it("preserves the image-build failure when retry is declined", async () => {
    const failure = new Error("Cloudflare build failed");
    const build = vi.fn<() => Promise<never>>().mockRejectedValue(failure);
    const confirmRetry = vi
      .fn<(options: { message: string; default: boolean }) => Promise<boolean>>()
      .mockResolvedValue(false);

    await expect(
      retryRemoteRunnerImageBuild(build, { confirmRetry, reportFailure: vi.fn<(message: string) => void>() }),
    ).rejects.toBe(failure);
    expect(build).toHaveBeenCalledOnce();
  });

  it("uses the selected organization manifest endpoint", () => {
    expect(githubAppManifestRegistrationUrl({ type: "personal", login: "ben" })).toBe(
      "https://github.com/settings/apps/new",
    );
    expect(githubAppManifestRegistrationUrl({ type: "organization", login: "ahoylabs" })).toBe(
      "https://github.com/organizations/ahoylabs/settings/apps/new",
    );
  });

  it("parses complete Worker token-validation status", () => {
    expect(
      parseRunnerSetupTokenStatus(
        JSON.stringify({
          cloudflareContainersToken: true,
          cloudflareRegistryPush: true,
          cloudflareResourceTagging: true,
          githubApp: true,
          githubAppWebhookSecret: true,
          resourceTraceSigningKey: true,
          runnerCacheSigningKey: true,
        }),
      ),
    ).toEqual({
      cloudflareContainersToken: true,
      cloudflareRegistryPush: true,
      cloudflareResourceTagging: true,
      githubApp: true,
      githubAppWebhookSecret: true,
      resourceTraceSigningKey: true,
      runnerCacheSigningKey: true,
    });
    expect(() => parseRunnerSetupTokenStatus("{}")).toThrow(/incomplete token validation information/u);
  });

  it("keeps a discovered GitHub App configuration until the user explicitly replaces it", () => {
    const unavailableApp = { githubApp: false, githubAppWebhookSecret: false };

    expect(shouldCreateInitialGitHubApp(unavailableApp, true)).toBe(false);
    expect(shouldCreateInitialGitHubApp(unavailableApp, false)).toBe(true);
    expect(shouldCreateInitialGitHubApp({ githubApp: true, githubAppWebhookSecret: true }, false)).toBe(false);
  });

  it("summarizes existing Worker credentials without exposing their values", () => {
    expect(
      existingWorkerTokenStatusMessages({
        cloudflareContainersToken: true,
        cloudflareRegistryPush: true,
        cloudflareResourceTagging: true,
        githubApp: false,
        githubAppWebhookSecret: true,
        resourceTraceSigningKey: true,
        runnerCacheSigningKey: false,
      }),
    ).toEqual([
      "✔ Cloudflare Containers Write + Tag Read/Write token: valid (reusing)",
      "✘ GitHub App credentials: unavailable or rejected",
      "✔ Runner resource-trace signing key: present (reusing)",
      "✘ Runner R2-cache signing key: missing",
    ]);
  });

  it("retries temporary Worker validation authorization failures", async () => {
    let attempts = 0;
    const result = await retryWorkerTokenValidation(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new WorkerTokenValidationError(401);
        }
        return "validated";
      },
      { attempts: 3, retryDelayMs: 0 },
    );

    expect(result).toBe("validated");
    expect(attempts).toBe(3);
  });

  it("retries setup requests routed to a previous Worker secret version", async () => {
    let attempts = 0;
    const response = await waitForWorkerSetupAuthorization(
      async () => {
        attempts += 1;
        return new Response(undefined, { status: attempts < 3 ? 401 : 200 });
      },
      { attempts: 3, retryDelayMs: 0 },
    );

    expect(response.status).toBe(200);
    expect(attempts).toBe(3);
  });

  it("does not retry a non-authorization setup failure", async () => {
    let attempts = 0;
    const response = await waitForWorkerSetupAuthorization(
      async () => {
        attempts += 1;
        return new Response(undefined, { status: 500 });
      },
      { attempts: 3, retryDelayMs: 0 },
    );

    expect(response.status).toBe(500);
    expect(attempts).toBe(1);
  });

  it("can wait for a newly deployed setup endpoint to replace a previous Worker version", async () => {
    let attempts = 0;
    const response = await waitForWorkerSetupAuthorization(
      async () => {
        attempts += 1;
        return new Response(undefined, { status: attempts < 3 ? 404 : 200 });
      },
      { attempts: 3, retryDelayMs: 0, retryStatuses: [401, 404] },
    );

    expect(response.status).toBe(200);
    expect(attempts).toBe(3);
  });

  it("waits for workers.dev to become available after deployment", async () => {
    let attempts = 0;

    await expect(
      waitForWorkerHealthCheck(
        async () => {
          attempts += 1;
          if (attempts < 3) {
            throw new WorkerHealthCheckError(404, "https://runner.example.workers.dev");
          }
        },
        { attempts: 3, retryDelayMs: 0 },
      ),
    ).resolves.toBeUndefined();

    expect(attempts).toBe(3);
  });

  it("does not retry a permanent Worker health failure", async () => {
    const check = async () => {
      throw new WorkerHealthCheckError(401, "https://runner.example.workers.dev");
    };

    await expect(waitForWorkerHealthCheck(check, { attempts: 3, retryDelayMs: 0 })).rejects.toThrow(
      "status 401 at https://runner.example.workers.dev",
    );
  });

  it("waits for the Worker to validate newly stored credentials", async () => {
    let attempts = 0;
    const ready = {
      cloudflareContainersToken: true,
      cloudflareRegistryPush: true,
      cloudflareResourceTagging: true,
      githubApp: true,
      githubAppWebhookSecret: true,
      resourceTraceSigningKey: true,
      runnerCacheSigningKey: true,
    };
    const pending = { ...ready, cloudflareContainersToken: false };

    const result = await waitForWorkerTokenValidation(
      async () => {
        attempts += 1;
        return attempts < 3 ? pending : ready;
      },
      { attempts: 3, retryDelayMs: 0, isValid: hasValidRunnerSetupTokenStatus },
    );

    expect(result).toEqual(ready);
    expect(attempts).toBe(3);
    expect(hasValidRunnerSetupTokenStatus(pending)).toBe(false);
  });

  it("extracts and normalizes the deployed workers.dev URL", () => {
    expect(extractWorkerBaseUrl("Deployed\n  https://runner.example.workers.dev\n")).toBe(
      "https://runner.example.workers.dev",
    );
    expect(normalizeWorkerBaseUrl("https://runner.example.workers.dev///?ignored=true#ignored")).toBe(
      "https://runner.example.workers.dev",
    );
    expect(normalizeWorkerBaseUrl("http://runner.example.workers.dev")).toBeUndefined();
  });
});
