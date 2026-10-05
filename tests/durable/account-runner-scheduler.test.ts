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

  it("recovers a lost in_progress delivery by asking GitHub which job the runner executes", async () => {
    const scheduler = env.RUNNER_SCHEDULER.getByName("github-reconcile");
    const queuedJob = job("500", "cf-standard-3-job-500", "refs/pull/500/merge");
    const reassignedJob = job("600", "cf-standard-3-job-600", "refs/pull/600/merge");

    await scheduler.submit(queuedJob);
    await scheduler.submit(reassignedJob);
    await provisionRunner(scheduler, queuedJob.jobId, queuedJob.runnerName, 5_001);

    // GitHub assigned the provisioned runner to a different job and its
    // in_progress webhook never reached the Worker. The claim must still
    // resolve through the GitHub API self-heal instead of timing the job out.
    await runInDurableObject(scheduler, async (instance) => {
      instance.jobDetailOverride = async (jobId) =>
        jobId === reassignedJob.jobId
          ? { status: "in_progress", runner_id: 5_001, runner_name: queuedJob.runnerName }
          : { status: "queued", runner_id: null, runner_name: null };
    });

    await expect(scheduler.cacheAssignment(queuedJob.runnerName, "biw/runner-poc")).resolves.toEqual({
      jobId: reassignedJob.jobId,
      cacheScope: {
        scope: reassignedJob.cacheScope?.scope,
        fallbackScope: "refs/heads/main",
        writeAllowed: true,
      },
    });

    // The ownership transfer must run through the same path as the webhook:
    // the displaced job is requeued under a fresh retry runner name and the
    // actual job takes over the runner reservation.
    await runInDurableObject(scheduler, async (_instance, state) => {
      // SAFETY: the query selects exactly these two columns and every row carries them.
      const displaced = state.storage.sql
        .exec(`SELECT status, runner_name FROM scheduler_jobs WHERE job_id = ?`, queuedJob.jobId)
        .toArray()[0] as { status: string; runner_name: string };
      expect(["queued", "admitted", "provisioning"]).toContain(displaced.status);
      // The displaced job is requeued under a fresh `-rN` runner name (the
      // provisioning workflow may fail in the test environment and retry).
      expect(displaced.runner_name).toMatch(/cf-standard-3-job-500-r\d+/u);
      // SAFETY: the query selects exactly these three columns and every row carries them.
      const actual = state.storage.sql
        .exec(
          `SELECT status, runner_name, github_assignment_observed FROM scheduler_jobs WHERE job_id = ?`,
          reassignedJob.jobId,
        )
        .toArray()[0] as { status: string; runner_name: string; github_assignment_observed: number };
      expect(actual.status).toBe("running");
      expect(actual.runner_name).toBe(queuedJob.runnerName);
      expect(actual.github_assignment_observed).toBe(1);
    });
  });

  it("adopts the running job when its runner was already displaced by a mutual cross-assignment", async () => {
    const scheduler = env.RUNNER_SCHEDULER.getByName("mutual-cross-assign");
    const jobA = job("900", "cf-standard-3-job-900", "refs/pull/900/merge");
    const jobB = job("901", "cf-standard-3-job-901", "refs/pull/901/merge");

    await scheduler.submit(jobA);
    await scheduler.submit(jobB);
    await provisionRunner(scheduler, jobA.jobId, jobA.runnerName, 9_001);
    await provisionRunner(scheduler, jobB.jobId, jobB.runnerName, 9_002);

    // GitHub cross-assigns both runners: RA executes B, RB executes A.
    await scheduler.workflowJobStarted({
      jobId: jobB.jobId,
      runnerName: jobA.runnerName,
      runnerId: 9_001,
      target,
      profile,
    });
    // RB's owner row (job B) was just moved onto RA, so nothing owns RB. The
    // scheduler must still adopt job A onto RB instead of leaving A queued
    // behind the never-provisioned `RA-r1` runner.
    await scheduler.workflowJobStarted({
      jobId: jobA.jobId,
      runnerName: jobB.runnerName,
      runnerId: 9_002,
      target,
      profile,
    });

    await expect(scheduler.cacheAssignment(jobB.runnerName, "biw/runner-poc")).resolves.toEqual({
      jobId: jobA.jobId,
      cacheScope: {
        scope: jobA.cacheScope?.scope,
        fallbackScope: "refs/heads/main",
        writeAllowed: true,
      },
    });
    await runInDurableObject(scheduler, async (_instance, state) => {
      // SAFETY: the query selects exactly these two columns and every row carries them.
      const adopted = state.storage.sql
        .exec(`SELECT status, runner_name FROM scheduler_jobs WHERE job_id = ?`, jobA.jobId)
        .toArray()[0] as { status: string; runner_name: string };
      expect(adopted.status).toBe("running");
      expect(adopted.runner_name).toBe(jobB.runnerName);
    });
  });

  it("does not resolve an assignment when GitHub reports the job on the runner is finished", async () => {
    const scheduler = env.RUNNER_SCHEDULER.getByName("github-reconcile-empty");
    const queuedJob = job("700", "cf-standard-3-job-700", "refs/pull/700/merge");

    await scheduler.submit(queuedJob);
    await provisionRunner(scheduler, queuedJob.jobId, queuedJob.runnerName, 7_001);

    await runInDurableObject(scheduler, async (instance) => {
      // The runner name matches but the job already completed, so the status
      // check itself must deny the claim.
      instance.jobDetailOverride = async () => ({
        status: "completed",
        runner_id: 7_001,
        runner_name: queuedJob.runnerName,
      });
    });

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
