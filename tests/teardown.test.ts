import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildTeardownInventory,
  cloudflareAccountTokenSettingsUrl,
  cloudflareDeletionOperations,
  collapseTeardownAccountCandidates,
  encodeR2ObjectKey,
  githubAppSettingsUrl,
  githubTeardownOwnerMatches,
  promptForGitHubTeardownOwner,
  promptForTeardownConfirmation,
  promptForTeardownScopes,
} from "../scripts/teardown";

const config = {
  name: "cloudflare-github-actions-runner",
  containers: [
    { name: "cloudflare-github-actions-runner-image-builder" },
    { name: "cloudflare-github-actions-runner-runner" },
  ],
  workflows: [
    { name: "cloudflare-github-actions-runner-provisioning" },
    { name: "cloudflare-github-actions-runner-image-build" },
  ],
  d1_databases: [{ database_name: "cloudflare-github-actions-runner-metrics" }],
  r2_buckets: [
    { binding: "RUNNER_CACHE", bucket_name: "cloudflare-github-actions-runner-cache" },
    { binding: "RUNNER_IMAGE_SOURCE", bucket_name: "cloudflare-github-actions-runner-cache" },
  ],
  vars: {
    RUNNER_IMAGE_NAME: "cloudflare-github-actions-runner-runner",
    RUNNER_IMAGE_BUILDER_IMAGE_NAME: "cloudflare-github-actions-runner-image-builder",
  },
};

describe("interactive teardown", () => {
  it("selects Cloudflare and GitHub cleanup together by default", async () => {
    const prompt = vi
      .fn<(options: { message: string; choices: unknown[] }) => Promise<string[]>>()
      .mockResolvedValue(["cloudflare", "github"]);

    await expect(promptForTeardownScopes(prompt)).resolves.toEqual({ cloudflare: true, github: true });
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Which parts of setup should be removed?",
        choices: [
          expect.objectContaining({ name: "Cloudflare setup", value: "cloudflare", checked: true }),
          expect.objectContaining({ name: "GitHub setup", value: "github", checked: true }),
        ],
      }),
    );
  });

  it("allows either cleanup target or neither to be selected", async () => {
    const prompt = vi
      .fn<(options: { message: string; choices: unknown[] }) => Promise<string[]>>()
      .mockResolvedValue(["github"]);
    await expect(promptForTeardownScopes(prompt)).resolves.toEqual({ cloudflare: false, github: true });

    prompt.mockResolvedValue([]);
    await expect(promptForTeardownScopes(prompt)).resolves.toEqual({ cloudflare: false, github: false });
  });

  it("asks once whether to delete the listed resources and defaults to no", async () => {
    const prompt = vi
      .fn<(options: { message: string; default: boolean }) => Promise<boolean>>()
      .mockResolvedValue(false);

    await expect(promptForTeardownConfirmation(prompt)).resolves.toBe(false);
    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledWith({ message: "Would you like to delete these resources?", default: false });
  });

  it("explicitly asks which GitHub account or organization to tear down", async () => {
    const owners = [
      { type: "personal", login: "biw", name: "Ben Williams" },
      { type: "organization", login: "ahoylabs", name: "Ahoy Labs" },
    ];
    const prompt = vi.fn<(options: { message: string; choices: unknown[] }) => Promise<(typeof owners)[number]>>();
    prompt.mockResolvedValue(owners[1]);

    await expect(promptForGitHubTeardownOwner(owners, "ahoylabs", prompt)).resolves.toBe(owners[1]);
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Which GitHub account or organization should be torn down?",
        choices: [
          expect.objectContaining({ name: expect.stringContaining("ahoylabs"), value: owners[1] }),
          expect.objectContaining({ name: expect.stringContaining("biw"), value: owners[0] }),
        ],
      }),
    );
  });

  it("refuses to tear down a different GitHub App owner", () => {
    const status = { owner: { login: "ahoylabs" } };
    expect(githubTeardownOwnerMatches(status, { login: "AHOYLABS" })).toBe(true);
    expect(githubTeardownOwnerMatches(status, { login: "biw" })).toBe(false);
  });

  it("prefers one explicitly selected Wrangler profile per account", () => {
    const candidates = [
      { account: { id: "account-1", name: "Ahoy Labs" }, profile: "default" },
      { account: { id: "account-1", name: "Ahoy Labs" }, profile: "work" },
      { account: { id: "account-2", name: "Ben Williams" }, profile: "personal" },
    ];

    expect(collapseTeardownAccountCandidates(candidates, "work")).toEqual([candidates[1], candidates[2]]);
  });

  it("inventories only exact setup-managed resource names", () => {
    const inventory = buildTeardownInventory(config, {
      workerSettings: {
        bindings: [
          { name: "RUNNER_CACHE", bucket_name: "custom-runner-cache" },
          { name: "RUNNER_IMAGE_SOURCE", bucket_name: "custom-runner-cache" },
          { name: "RUNNER_POOL_GITHUB_OWNER", text: "ahoylabs" },
          { name: "GITHUB_APP_ID" },
          { name: "GITHUB_APP_PRIVATE_KEY" },
          { name: "GITHUB_APP_WEBHOOK_SECRET" },
          { name: "UNRELATED", bucket_name: "customer-data" },
        ],
      },
      applications: [
        { id: "app-1", name: "cloudflare-github-actions-runner-runner" },
        { id: "app-2", name: "cloudflare-github-actions-runner-runner-copy" },
      ],
      workflows: [
        { id: "workflow-id", name: "cloudflare-github-actions-runner-image-build" },
        { id: "workflow-copy-id", name: "cloudflare-github-actions-runner-image-build-copy" },
      ],
      databases: [
        { name: "cloudflare-github-actions-runner-metrics", uuid: "database-id" },
        { name: "cloudflare-github-actions-runner-metrics-backup" },
      ],
      buckets: [
        { name: "cloudflare-github-actions-runner-cache" },
        { name: "cloudflare-github-actions-runner-image-source" },
        { name: "custom-runner-cache" },
        { name: "customer-data" },
      ],
      images: [
        { name: "cloudflare-github-actions-runner-runner", tags: ["runner-1", "runner-2"] },
        { name: "cloudflare-github-actions-runner-runner-copy", tags: ["runner-1"] },
      ],
    });

    expect(inventory).toEqual({
      worker: "cloudflare-github-actions-runner",
      githubOwner: "ahoylabs",
      githubAppConfigured: true,
      ownershipManifest: undefined,
      applications: [{ id: "app-1", name: "cloudflare-github-actions-runner-runner" }],
      workflows: [{ id: "workflow-id", name: "cloudflare-github-actions-runner-image-build" }],
      databases: [{ id: "database-id", name: "cloudflare-github-actions-runner-metrics", uuid: "database-id" }],
      buckets: [{ name: "custom-runner-cache" }],
      images: ["cloudflare-github-actions-runner-runner:runner-1", "cloudflare-github-actions-runner-runner:runner-2"],
    });
  });

  it("orders shutdown before irreversible storage deletion", () => {
    const operations = cloudflareDeletionOperations({
      worker: "runner-worker",
      workflows: [{ name: "runner-workflow" }],
      applications: [{ id: "app-id", name: "runner-app" }],
      images: ["runner-image:tag"],
      buckets: [{ name: "runner-bucket" }],
      databases: [{ name: "runner-database" }],
    });

    expect(operations.map(({ kind }) => kind)).toEqual([
      "workflow",
      "worker",
      "application",
      "image",
      "bucket",
      "database",
    ]);
  });

  it("preserves R2 key slashes while escaping every key segment", () => {
    expect(encodeR2ObjectKey("runner-cache/npm/a file+1.tgz")).toBe("runner-cache/npm/a%20file%2B1.tgz");
  });

  it("targets the owning GitHub account's App settings page", () => {
    expect(
      githubAppSettingsUrl({
        slug: "cloudflare-actions-runner",
        owner: { login: "ahoylabs", type: "Organization" },
      }),
    ).toBe("https://github.com/organizations/ahoylabs/settings/apps/cloudflare-actions-runner");
    expect(githubAppSettingsUrl({ slug: "cloudflare-actions-runner", owner: { login: "biw", type: "User" } })).toBe(
      "https://github.com/settings/apps/cloudflare-actions-runner",
    );
  });

  it("targets the selected Cloudflare account's API token settings", () => {
    expect(cloudflareAccountTokenSettingsUrl("account/with spaces")).toBe(
      "https://dash.cloudflare.com/account%2Fwith%20spaces/api-tokens",
    );
  });
});
