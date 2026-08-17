import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vite-plus/test";

import type { RunnerProvisioningPlan, SchedulerAdmission } from "../../src/account-runner-scheduler";
import type { WorkerEnvironment } from "../../src/environment";
import { startInvalidRunner, type InvalidRunnerEligibilityDependencies } from "../../src/index";
import {
  releaseIfRepositoryIsIneligible,
  type EligibilityReleaseDependencies,
} from "../../src/runner-provisioning-workflow";
import { RUNNER_PROFILES } from "../../src/runner-profiles";

const plan: RunnerProvisioningPlan = {
  kind: "provision",
  jobId: "94035733533",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  runnerName: "cf-standard-3-job-94035733533",
  target: { owner: "ahoylabs", repository: "runner-test" },
  workerOrigin: "https://runner.example.workers.dev",
  installationId: 42,
  profile: RUNNER_PROFILES["standard-3"],
  slotId: "preset:standard-3",
  applicationName: "cloudflare-github-actions-runner-githubactionsrunner",
  requiredMaxInstances: 2,
  capacityGeneration: 3,
  requiresConfiguration: false,
};

// SAFETY: every test injects the only dependency that reads the environment,
// and the rejected paths return before production bindings are accessed.
const testEnvironment = env as WorkerEnvironment;

describe("delayed runner repository authorization", () => {
  it.each(["public", "internal", "unverifiable"] as const)(
    "releases capacity and admits the next job when visibility becomes %s",
    async (visibility) => {
      const admissions: SchedulerAdmission[] = [
        { jobId: "next", runnerName: "cf-standard-3-job-next", workflowId: "runner-next" },
      ];
      const provisioningFailed = vi
        .fn<(jobId: string, reason: string) => Promise<{ admissions: SchedulerAdmission[] }>>()
        .mockResolvedValue({ admissions });
      const dependencies: EligibilityReleaseDependencies = {
        authorize: vi.fn<EligibilityReleaseDependencies["authorize"]>().mockResolvedValue({
          kind: "rejected",
          visibility,
          checkReported: true,
        }),
        startProvisioning: vi.fn<EligibilityReleaseDependencies["startProvisioning"]>().mockResolvedValue(undefined),
      };

      await expect(
        releaseIfRepositoryIsIneligible(testEnvironment, { provisioningFailed }, plan, dependencies),
      ).resolves.toBe(true);
      expect(dependencies.authorize).toHaveBeenCalledExactlyOnceWith(testEnvironment, {
        jobId: plan.jobId,
        headSha: plan.headSha,
        target: plan.target,
        installationId: plan.installationId,
      });
      expect(provisioningFailed).toHaveBeenCalledExactlyOnceWith(plan.jobId, `Repository visibility is ${visibility}`);
      expect(dependencies.startProvisioning).toHaveBeenCalledExactlyOnceWith(testEnvironment, admissions);
    },
  );

  it("keeps a private reservation without releasing or starting another workflow", async () => {
    const provisioningFailed =
      vi.fn<(jobId: string, reason: string) => Promise<{ admissions: SchedulerAdmission[] }>>();
    const dependencies: EligibilityReleaseDependencies = {
      authorize: vi.fn<EligibilityReleaseDependencies["authorize"]>().mockResolvedValue({ kind: "private" }),
      startProvisioning: vi.fn<EligibilityReleaseDependencies["startProvisioning"]>(),
    };

    await expect(
      releaseIfRepositoryIsIneligible(testEnvironment, { provisioningFailed }, plan, dependencies),
    ).resolves.toBe(false);
    expect(provisioningFailed).not.toHaveBeenCalled();
    expect(dependencies.startProvisioning).not.toHaveBeenCalled();
  });

  it("rechecks a diagnostic job and stops before fetching a JIT credential when authorization is lost", async () => {
    const dependencies: InvalidRunnerEligibilityDependencies = {
      authorize: vi.fn<InvalidRunnerEligibilityDependencies["authorize"]>().mockResolvedValue({
        kind: "rejected",
        visibility: "public",
        checkReported: true,
      }),
    };

    await expect(
      startInvalidRunner(
        testEnvironment,
        plan.target,
        {
          kind: "invalid-runner",
          jobId: plan.jobId,
          headSha: plan.headSha,
          runnerName: "cf-validation-job-94035733533",
          labels: ["cloudflare-vcpu:99-memory_mib:1-disk_mb:1"],
          title: "Invalid Cloudflare custom runner",
          errors: ["vCPU is invalid"],
          installationId: 42,
        },
        dependencies,
      ),
    ).resolves.toBe("rejected");
    expect(dependencies.authorize).toHaveBeenCalledExactlyOnceWith(testEnvironment, {
      jobId: plan.jobId,
      headSha: plan.headSha,
      target: plan.target,
      installationId: plan.installationId,
    });
  });
});
