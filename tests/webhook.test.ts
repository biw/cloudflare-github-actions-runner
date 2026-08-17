import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { parseCustomRunnerLabel, RUNNER_PROFILES } from "../src/runner-profiles";
import {
  classifyAuthorizedQueuedWebhook,
  classifyGitHubWebhook,
  classifyGitHubWebhookIntent,
  hasValidGitHubSignature,
} from "../src/webhook";

const expectedRepository = "biw/cloudflare-github-actions-runner";

interface WorkflowJobPayloadOverrides {
  action?: z.core.util.JSONType;
  installation?: z.core.util.JSONType;
  repository?: z.core.util.JSONType;
  workflow_job?: z.core.util.JSONType;
  ref?: z.core.util.JSONType;
}

function workflowJobPayload(overrides: WorkflowJobPayloadOverrides = {}): string {
  const defaultWorkflowJob = {
    id: 94035733533,
    head_sha: "0123456789abcdef0123456789abcdef01234567",
    labels: ["self-hosted", "Linux", "X64", "cloudflare-ubuntu-latest"],
  };
  const workflowJobOverride = z.record(z.string(), z.json()).safeParse(overrides.workflow_job);
  return JSON.stringify({
    action: "queued",
    installation: { id: 123 },
    repository: { full_name: expectedRepository },
    ...overrides,
    workflow_job: workflowJobOverride.success
      ? { ...defaultWorkflowJob, ...workflowJobOverride.data }
      : (overrides.workflow_job ?? defaultWorkflowJob),
  });
}

describe("GitHub webhook handling", () => {
  it("verifies GitHub's documented HMAC-SHA256 test vector", async () => {
    const body = new TextEncoder().encode("Hello, World!").buffer;
    const signature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

    await expect(hasValidGitHubSignature(body, signature, "It's a Secret to Everybody")).resolves.toBe(true);
    await expect(hasValidGitHubSignature(body, signature, "wrong secret")).resolves.toBe(false);
    await expect(hasValidGitHubSignature(body, null, "It's a Secret to Everybody")).resolves.toBe(false);
  });

  it("provisions a uniquely named runner for a matching queued job", () => {
    expect(classifyGitHubWebhook("workflow_job", workflowJobPayload(), expectedRepository)).toEqual({
      kind: "job-queued",
      jobId: "94035733533",
      headSha: "0123456789abcdef0123456789abcdef01234567",
      runnerName: "cf-standard-3-job-94035733533",
      profile: RUNNER_PROFILES["standard-3"],
      installationId: 123,
    });
  });

  it.each([
    ["known preset", ["cloudflare-ubuntu-latest"]],
    ["valid custom", ["cloudflare-vcpu:2-memory_mib:6144-disk_mb:12000"]],
    ["malformed custom", ["cloudflare-vcpu:2-memory:6144-disk_mb:12000"]],
    ["conflicting", ["cloudflare-standard-2", "cloudflare-standard-4"]],
    ["unknown", ["cloudflare-ultra"]],
  ])("recognizes %s labels as Cloudflare intent before machine validation", (_name, labels) => {
    expect(
      classifyGitHubWebhookIntent(
        "workflow_job",
        workflowJobPayload({ workflow_job: { id: 42, labels } }),
        expectedRepository,
      ),
    ).toMatchObject({ kind: "cloudflare-job-queued", jobId: "42", labels });
  });

  it("fails an unknown reserved label and a valid-plus-unknown request through the private diagnostic path", () => {
    const unknown = classifyGitHubWebhookIntent(
      "workflow_job",
      workflowJobPayload({ workflow_job: { id: 42, labels: ["cloudflare-ultra"] } }),
      expectedRepository,
    );
    const mixed = classifyGitHubWebhookIntent(
      "workflow_job",
      workflowJobPayload({
        workflow_job: { id: 43, labels: ["cloudflare-ubuntu-latest", "cloudflare-ultra"] },
      }),
      expectedRepository,
    );

    expect(unknown.kind === "cloudflare-job-queued" ? classifyAuthorizedQueuedWebhook(unknown) : unknown).toMatchObject(
      {
        kind: "invalid-runner",
        errors: [expect.stringContaining('Unknown Cloudflare runner label "cloudflare-ultra"')],
      },
    );
    expect(mixed.kind === "cloudflare-job-queued" ? classifyAuthorizedQueuedWebhook(mixed) : mixed).toMatchObject({
      kind: "invalid-runner",
      errors: [expect.stringContaining('Unknown Cloudflare runner label "cloudflare-ultra"')],
    });
  });

  it("ignores unrelated labels before eligibility and fails closed without a queued head SHA", () => {
    expect(
      classifyGitHubWebhookIntent(
        "workflow_job",
        workflowJobPayload({ workflow_job: { id: 42, labels: ["ubuntu-latest"] } }),
        expectedRepository,
      ),
    ).toEqual({ kind: "ignored" });
    expect(
      classifyGitHubWebhookIntent(
        "workflow_job",
        workflowJobPayload({
          workflow_job: { id: 42, head_sha: null, labels: ["cloudflare-ubuntu-latest"] },
        }),
        expectedRepository,
      ),
    ).toEqual({ kind: "invalid" });
  });

  it("provides signed workflow-run context for GitHub-compatible cache scoping", () => {
    const defaultBranchBody = workflowJobPayload({
      repository: { full_name: expectedRepository, default_branch: "main" },
      workflow_job: {
        id: 42,
        run_id: 142,
        head_branch: "main",
        labels: ["cloudflare-ubuntu-latest"],
      },
    });
    const pullRequestBody = workflowJobPayload({
      repository: { full_name: expectedRepository, default_branch: "main" },
      workflow_job: {
        id: 43,
        run_id: 143,
        head_branch: "feature/cache",
        labels: ["cloudflare-ubuntu-latest"],
      },
    });

    expect(classifyGitHubWebhook("workflow_job", defaultBranchBody, expectedRepository)).toMatchObject({
      kind: "job-queued",
      workflowRunId: 142,
      defaultBranch: "main",
    });
    expect(classifyGitHubWebhook("workflow_job", pullRequestBody, expectedRepository)).toMatchObject({
      kind: "job-queued",
      workflowRunId: 143,
      defaultBranch: "main",
    });
  });

  it.each([
    ["cloudflare-lite", "lite"],
    ["cloudflare-basic", "basic"],
    ["cloudflare-standard-1", "standard-1"],
    ["cloudflare-standard-2", "standard-2"],
    ["cloudflare-standard-3", "standard-3"],
    ["cloudflare-ubuntu-latest", "standard-3"],
    ["cloudflare-standard-4", "standard-4"],
  ] as const)("routes the %s label to the %s profile", (label, profileKey) => {
    const body = workflowJobPayload({
      workflow_job: { id: 42, labels: ["self-hosted", "Linux", "X64", label] },
    });

    expect(classifyGitHubWebhook("workflow_job", body, expectedRepository)).toEqual({
      kind: "job-queued",
      jobId: "42",
      headSha: "0123456789abcdef0123456789abcdef01234567",
      runnerName: `cf-${profileKey}-job-42`,
      profile: RUNNER_PROFILES[profileKey],
      installationId: 123,
    });
  });

  it("allows both Standard-3 aliases but fails labels for different profiles", () => {
    expect(
      classifyGitHubWebhook(
        "workflow_job",
        workflowJobPayload({
          workflow_job: {
            id: 42,
            labels: ["cloudflare-standard-3", "cloudflare-ubuntu-latest"],
          },
        }),
        expectedRepository,
      ),
    ).toEqual({
      kind: "job-queued",
      jobId: "42",
      headSha: "0123456789abcdef0123456789abcdef01234567",
      runnerName: "cf-standard-3-job-42",
      profile: RUNNER_PROFILES["standard-3"],
      installationId: 123,
    });

    expect(
      classifyGitHubWebhook(
        "workflow_job",
        workflowJobPayload({
          workflow_job: { id: 42, labels: ["cloudflare-standard-2", "cloudflare-standard-4"] },
        }),
        expectedRepository,
      ),
    ).toMatchObject({
      kind: "invalid-runner",
      jobId: "42",
      runnerName: "cf-validation-job-42",
      title: "Invalid Cloudflare runner selection",
      errors: ["Select exactly one Cloudflare runner profile. A job cannot request multiple machine profiles."],
    });
  });

  it("creates a custom profile directly from a valid runs-on label", () => {
    const label = "cloudflare-vcpu:2-memory_mib:6144-disk_mb:12000";
    const parsed = parseCustomRunnerLabel(label);
    expect(parsed.kind).toBe("valid");

    expect(
      classifyGitHubWebhook(
        "workflow_job",
        workflowJobPayload({ workflow_job: { id: 42, labels: [label] } }),
        expectedRepository,
      ),
    ).toEqual({
      kind: "job-queued",
      jobId: "42",
      headSha: "0123456789abcdef0123456789abcdef01234567",
      runnerName: "cf-custom-v2-m6144-d12000-job-42",
      profile: parsed.kind === "valid" ? parsed.profile : undefined,
      installationId: 123,
    });
  });

  it.each([
    ["cloudflare-vcpu:5-memory_mib:12288-disk_mb:20000", "vCPU must be a whole number from 1 through 4; received 5."],
    [
      "cloudflare-vcpu:2-memory_mib:4096-disk_mb:8000",
      "memory_mib must be at least 3,072 MiB per vCPU; 4096 MiB is below the 6144 MiB minimum for 2 vCPU.",
    ],
    [
      "cloudflare-vcpu:1-memory_mib:3072-disk_mb:7000",
      "disk_mb must be no more than 2 GB per 1 GB memory; 7000 MB exceeds the 6000 MB maximum for 3072 MiB.",
    ],
    [
      "cloudflare-vcpu:2-memory:6144-disk_mb:12000",
      "Use the exact label format cloudflare-vcpu:<integer>-memory_mib:<integer>-disk_mb:<integer>.",
    ],
  ])("creates a failed-job diagnostic for invalid custom label %s", (label, error) => {
    expect(
      classifyGitHubWebhook(
        "workflow_job",
        workflowJobPayload({ workflow_job: { id: 42, labels: [label] } }),
        expectedRepository,
      ),
    ).toMatchObject({
      kind: "invalid-runner",
      jobId: "42",
      runnerName: "cf-validation-job-42",
      labels: [label],
      title: "Invalid Cloudflare custom runner",
      errors: expect.arrayContaining([error]),
      installationId: 123,
    });
  });

  it("lists every custom-size rule violated by one label", () => {
    const parsed = parseCustomRunnerLabel("cloudflare-vcpu:5-memory_mib:13000-disk_mb:26000");

    expect(parsed).toEqual({
      kind: "invalid",
      errors: [
        "vCPU must be a whole number from 1 through 4; received 5.",
        "memory_mib must be at most 12,288 MiB (12 GiB); received 13000 MiB.",
        "memory_mib must be at least 3,072 MiB per vCPU; 13000 MiB is below the 15360 MiB minimum for 5 vCPU.",
        "disk_mb must be at most 20,000 MB (20 GB); received 26000 MB.",
        "disk_mb must be no more than 2 GB per 1 GB memory; 26000 MB exceeds the 25390 MB maximum for 13000 MiB.",
      ],
    });
  });

  it("rejects a job that combines custom and preset profiles", () => {
    expect(
      classifyGitHubWebhook(
        "workflow_job",
        workflowJobPayload({
          workflow_job: {
            id: 42,
            labels: ["cloudflare-standard-2", "cloudflare-vcpu:2-memory_mib:6144-disk_mb:12000"],
          },
        }),
        expectedRepository,
      ),
    ).toMatchObject({
      kind: "invalid-runner",
      title: "Invalid Cloudflare runner selection",
    });
  });

  it("acknowledges pings and ignores unrelated workflow jobs", () => {
    expect(classifyGitHubWebhook("ping", "{}", expectedRepository)).toEqual({ kind: "ping" });
    expect(
      classifyGitHubWebhook(
        "workflow_job",
        workflowJobPayload({
          action: "completed",
          workflow_job: {
            id: 94035733533,
            labels: ["cloudflare-ubuntu-latest"],
            runner_name: "cf-standard-3-job-94035733533",
          },
        }),
        expectedRepository,
      ),
    ).toEqual({ kind: "job-completed", jobId: "94035733533" });
    expect(
      classifyGitHubWebhook(
        "workflow_job",
        workflowJobPayload({ workflow_job: { id: 42, labels: ["ubuntu-latest"] } }),
        expectedRepository,
      ),
    ).toEqual({ kind: "ignored" });
    expect(
      classifyGitHubWebhook(
        "workflow_job",
        workflowJobPayload({ repository: { full_name: "someone/else" } }),
        expectedRepository,
      ),
    ).toEqual({ kind: "ignored" });
  });

  it("does not touch the scheduler for an unassigned or diagnostic completion", () => {
    expect(
      classifyGitHubWebhook("workflow_job", workflowJobPayload({ action: "completed" }), expectedRepository),
    ).toEqual({ kind: "ignored" });
    expect(
      classifyGitHubWebhook(
        "workflow_job",
        workflowJobPayload({
          action: "completed",
          workflow_job: {
            id: 42,
            labels: ["cloudflare-vcpu:5-memory_mib:12288-disk_mb:20000"],
            runner_name: "cf-validation-job-42",
          },
        }),
        expectedRepository,
      ),
    ).toEqual({ kind: "ignored" });
  });

  it("captures GitHub's actual JIT runner assignment", () => {
    expect(
      classifyGitHubWebhook(
        "workflow_job",
        workflowJobPayload({
          action: "in_progress",
          workflow_job: {
            id: 42,
            labels: ["self-hosted", "Linux", "X64", "cloudflare-ubuntu-latest"],
            runner_id: 99,
            runner_name: "cf-standard-3-job-100",
          },
        }),
        expectedRepository,
      ),
    ).toEqual({
      kind: "job-started",
      jobId: "42",
      runnerId: 99,
      runnerName: "cf-standard-3-job-100",
      profile: RUNNER_PROFILES["standard-3"],
      installationId: 123,
    });
  });

  it("ignores an in-progress job without a runner assignment", () => {
    expect(
      classifyGitHubWebhook("workflow_job", workflowJobPayload({ action: "in_progress" }), expectedRepository),
    ).toEqual({ kind: "ignored" });
  });

  it("does not provision a second diagnostic runner after GitHub assigns the failed job", () => {
    expect(
      classifyGitHubWebhook(
        "workflow_job",
        workflowJobPayload({
          action: "in_progress",
          workflow_job: {
            id: 42,
            labels: ["cloudflare-vcpu:5-memory_mib:12288-disk_mb:20000"],
            runner_name: "cf-validation-job-42",
          },
        }),
        expectedRepository,
      ),
    ).toEqual({ kind: "ignored" });
  });

  it("rejects malformed matching workflow jobs", () => {
    expect(classifyGitHubWebhook("workflow_job", "not json", expectedRepository)).toEqual({ kind: "invalid" });
    expect(
      classifyGitHubWebhook(
        "workflow_job",
        workflowJobPayload({ workflow_job: { id: "42", labels: ["cloudflare-standard-3"] } }),
        expectedRepository,
      ),
    ).toEqual({ kind: "invalid" });
  });
});
