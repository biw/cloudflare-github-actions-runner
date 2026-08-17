import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";

import type { SchedulerJobInput } from "../../src/account-runner-scheduler";
import { RUNNER_PROFILES } from "../../src/runner-profiles";

const target = { owner: "biw", repository: "runner-poc" };
const profile = RUNNER_PROFILES["standard-3"];

function job(jobId: string, runnerName: string, cacheScope: string): SchedulerJobInput {
  return {
    jobId,
    headSha: "0123456789abcdef0123456789abcdef01234567",
    runnerName,
    target,
    installationId: 42,
    profile,
    workerOrigin: "https://runner.example.workers.dev",
    cacheScope: { scope: cacheScope, fallbackScope: "refs/heads/main", writeAllowed: true },
  };
}

async function provisionRunner(
  scheduler: DurableObjectStub<import("../../src/account-runner-scheduler").AccountRunnerScheduler>,
  jobId: string,
  runnerName: string,
  runnerId: number,
): Promise<void> {
  await runInDurableObject(scheduler, async (_instance, state) => {
    // Admission capacity is separately covered by scheduler-policy tests. This
    // test prepares two live, compatible JIT runners to reproduce GitHub's
    // out-of-order assignment race without calling the Containers API. Mark
    // the pending capacity operation as already applied so the Durable Object
    // alarm cannot race this test and issue a real capacity request.
    state.storage.sql.exec(
      `UPDATE scheduler_slots
       SET applied_max_instances = desired_max_instances,
           capacity_debounce_until = 0,
           capacity_update_in_progress = 0
       WHERE slot_id = 'preset:standard-3'`,
    );
    state.storage.sql.exec(
      "UPDATE scheduler_jobs SET status = 'provisioning', slot_id = 'preset:standard-3' WHERE job_id = ?",
      jobId,
    );
  });
  await scheduler.runnerProvisioned(jobId, runnerName, runnerId);
  await scheduler.runnerStarted(runnerName);
}

describe("AccountRunnerScheduler JIT cache assignments", () => {
  it("carries the queued head SHA into the provisioning plan", async () => {
    const scheduler = env.RUNNER_SCHEDULER.getByName("head-sha-provisioning");
    const queuedJob = job("50", "cf-standard-3-job-50", "refs/heads/main");

    await scheduler.submit(queuedJob);
    await runInDurableObject(scheduler, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE scheduler_jobs SET status = 'provisioning', slot_id = 'preset:standard-3' WHERE job_id = ?`,
        queuedJob.jobId,
      );
      state.storage.sql.exec(
        `UPDATE scheduler_slots
         SET applied_max_instances = desired_max_instances,
             capacity_update_in_progress = 0,
             capacity_reclaim_pending = 0
         WHERE slot_id = 'preset:standard-3'`,
      );
    });

    await expect(scheduler.claimProvisioning(queuedJob.jobId)).resolves.toMatchObject({
      kind: "provision",
      jobId: queuedJob.jobId,
      headSha: queuedJob.headSha,
    });
  });

  it("keeps cache access with each runner when two compatible JIT runners cross-assign jobs", async () => {
    const scheduler = env.RUNNER_SCHEDULER.getByName("cross-assignment");
    const firstJob = job("100", "cf-standard-3-job-100", "refs/pull/100/merge");
    const secondJob = job("200", "cf-standard-3-job-200", "refs/pull/200/merge");

    await scheduler.submit(firstJob);
    await scheduler.submit(secondJob);
    await provisionRunner(scheduler, firstJob.jobId, firstJob.runnerName, 1_001);
    await provisionRunner(scheduler, secondJob.jobId, secondJob.runnerName, 2_001);

    // GitHub gives runner 100 job 200 first. The scheduler requeues job 100
    // under a new JIT name, so runner 200 no longer has a job row named after
    // it when GitHub later assigns runner 200 to job 100.
    await scheduler.workflowJobStarted({
      jobId: secondJob.jobId,
      runnerName: firstJob.runnerName,
      runnerId: 1_001,
      target,
      profile,
    });
    await scheduler.workflowJobStarted({
      jobId: firstJob.jobId,
      runnerName: secondJob.runnerName,
      runnerId: 2_001,
      target,
      profile,
    });

    await expect(scheduler.cacheAssignment(firstJob.runnerName, "biw/runner-poc")).resolves.toEqual({
      jobId: secondJob.jobId,
      cacheScope: { scope: secondJob.cacheScope?.scope, fallbackScope: "refs/heads/main", writeAllowed: true },
    });
    await expect(scheduler.cacheAssignment(secondJob.runnerName, "biw/runner-poc")).resolves.toEqual({
      jobId: firstJob.jobId,
      cacheScope: { scope: firstJob.cacheScope?.scope, fallbackScope: "refs/heads/main", writeAllowed: true },
    });
  });

  it("does not grant cache access before GitHub confirms the runner assignment", async () => {
    const scheduler = env.RUNNER_SCHEDULER.getByName("unassigned-runner");
    const queuedJob = job("300", "cf-standard-3-job-300", "refs/pull/300/merge");

    await scheduler.submit(queuedJob);
    await provisionRunner(scheduler, queuedJob.jobId, queuedJob.runnerName, 3_001);

    await expect(scheduler.cacheAssignment(queuedJob.runnerName, "biw/runner-poc")).resolves.toBeUndefined();
  });

  it("does not record an assignment across repository or machine-profile boundaries", async () => {
    const scheduler = env.RUNNER_SCHEDULER.getByName("isolated-assignment");
    const queuedJob = job("400", "cf-standard-3-job-400", "refs/pull/400/merge");

    await scheduler.submit(queuedJob);
    await provisionRunner(scheduler, queuedJob.jobId, queuedJob.runnerName, 4_001);
    await scheduler.workflowJobStarted({
      jobId: queuedJob.jobId,
      runnerName: queuedJob.runnerName,
      runnerId: 4_001,
      target: { owner: "biw", repository: "different-repository" },
      profile,
    });

    await expect(scheduler.cacheAssignment(queuedJob.runnerName, "biw/runner-poc")).resolves.toBeUndefined();
  });
});
