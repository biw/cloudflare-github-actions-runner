import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import type { SchedulerJobInput } from "../../src/account-runner-scheduler";
import { RUNNER_PROFILES } from "../../src/runner-profiles";

const target = { owner: "biw", repository: "runner-poc" };
const profile = RUNNER_PROFILES["standard-3"];

beforeAll(async () => {
  await env.RESOURCE_METRICS.prepare(
    `CREATE TABLE IF NOT EXISTS resource_trace_assignments (
      runner_name TEXT PRIMARY KEY, job_id TEXT NOT NULL, repository TEXT NOT NULL, assigned_at INTEGER NOT NULL
    )`,
  ).run();
});

async function assignmentClock(
  scheduler: DurableObjectStub<import("../../src/account-runner-scheduler").AccountRunnerScheduler>,
  fetch: typeof globalThis.fetch = async () => {
    throw new Error("Unexpected GitHub request");
  },
) {
  const clock = { time: 1_700_000_000_000 };
  await runInDurableObject(scheduler, async (instance) => {
    instance.assignmentDependencies = { fetch, now: () => clock.time };
  });
  return clock;
}

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

    // A late provisioning workflow for job A's abandoned `RA-r1` runner must
    // not tear the adopted job down: provisioningFailed only applies while
    // the job is still provisioning that exact runner name.
    await scheduler.provisioningFailed(jobA.jobId, "stale workflow", `${jobA.runnerName}-r1`);

    await runInDurableObject(scheduler, async (_instance, state) => {
      // SAFETY: the query selects exactly these two columns and every row carries them.
      const surviving = state.storage.sql
        .exec(`SELECT status, runner_name FROM scheduler_jobs WHERE job_id = ?`, jobA.jobId)
        .toArray()[0] as { status: string; runner_name: string };
      expect(surviving.status).toBe("running");
      expect(surviving.runner_name).toBe(jobB.runnerName);
    });
  });

  it("ignores a failure report from a superseded provisioning attempt", async () => {
    const scheduler = env.RUNNER_SCHEDULER.getByName("stale-provisioning-failure");
    const queuedJob = job("950", "cf-standard-3-job-950", "refs/pull/950/merge");
    const other = job("951", "cf-standard-3-job-951", "refs/pull/951/merge");

    await scheduler.submit(queuedJob);
    await scheduler.submit(other);
    await provisionRunner(scheduler, queuedJob.jobId, queuedJob.runnerName, 9_501);
    await provisionRunner(scheduler, other.jobId, other.runnerName, 9_502);

    // Cross-assignment: GitHub puts `other` on queuedJob's runner, requeueing
    // queuedJob under `cf-standard-3-job-950-r1`; the new attempt then claims
    // provisioning again.
    await scheduler.workflowJobStarted({
      jobId: other.jobId,
      runnerName: queuedJob.runnerName,
      runnerId: 9_501,
      target,
      profile,
    });
    // The fresh attempt claims provisioning again under the `-r1` runner
    // name (claimProvisioning may return `wait` while slot capacity is being
    // applied, so drive the state directly).
    await runInDurableObject(scheduler, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE scheduler_jobs SET status = 'provisioning', updated_at = ? WHERE job_id = ?`,
        Date.now(),
        queuedJob.jobId,
      );
    });

    // The superseded workflow reports its failure late; the job must not be
    // failed because its current runner name no longer matches.
    await scheduler.provisioningFailed(queuedJob.jobId, "stale workflow", queuedJob.runnerName);

    await runInDurableObject(scheduler, async (_instance, state) => {
      // SAFETY: the query selects exactly these two columns and every row carries them.
      const surviving = state.storage.sql
        .exec(`SELECT status, runner_name FROM scheduler_jobs WHERE job_id = ?`, queuedJob.jobId)
        .toArray()[0] as { status: string; runner_name: string };
      // The job may legitimately retry further (the test environment fails
      // real provisioning attempts), but the stale report must not kill it.
      expect(surviving.status).not.toBe("failed");
      expect(surviving.runner_name).toMatch(/cf-standard-3-job-950-r\d+/u);
    });
  });

  it("reconciles a running job whose in_progress webhook was lost", async () => {
    const scheduler = env.RUNNER_SCHEDULER.getByName("github-reconcile-running");
    const queuedJob = job("800", "cf-standard-3-job-800", "refs/pull/800/merge");

    await scheduler.submit(queuedJob);
    await provisionRunner(scheduler, queuedJob.jobId, queuedJob.runnerName, 8_001);
    // runnerStarted moves the job to `running` before GitHub's in_progress
    // webhook arrives; a lost delivery must still resolve.
    await scheduler.runnerStarted(queuedJob.runnerName);

    await runInDurableObject(scheduler, async (instance) => {
      instance.jobDetailOverride = async () => ({
        status: "in_progress",
        runner_id: 8_001,
        runner_name: queuedJob.runnerName,
      });
    });

    await expect(scheduler.cacheAssignment(queuedJob.runnerName, "biw/runner-poc")).resolves.toEqual({
      jobId: queuedJob.jobId,
      cacheScope: {
        scope: queuedJob.cacheScope?.scope,
        fallbackScope: "refs/heads/main",
        writeAllowed: true,
      },
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

  it("reaches a legacy assignment beyond 24 newer candidates in one bounded sweep", async () => {
    const scheduler = env.RUNNER_SCHEDULER.getByName("large-legacy-backlog");
    const source = job("1000", "cf-standard-3-job-1000", "refs/pull/1000/merge");
    await scheduler.submit(source);
    for (let id = 1001; id <= 1040; id += 1) {
      // eslint-disable-next-line no-await-in-loop -- prepare a deterministic queue with the executing job last.
      await scheduler.submit(job(String(id), `cf-standard-3-job-${id}`, `refs/pull/${id}/merge`));
    }
    await provisionRunner(scheduler, source.jobId, source.runnerName, 10_001);
    const clock = await assignmentClock(scheduler);
    const probes: string[] = [];
    await runInDurableObject(scheduler, async (instance) => {
      instance.jobDetailOverride = async (jobId) => {
        probes.push(jobId);
        clock.time += 10;
        return jobId === source.jobId
          ? { status: "in_progress", runner_id: 10_001, runner_name: source.runnerName }
          : { status: "queued", runner_id: null, runner_name: null };
      };
    });

    await expect(scheduler.cacheAssignment(source.runnerName, "biw/runner-poc")).resolves.toMatchObject({
      jobId: source.jobId,
    });
    expect(probes).toHaveLength(41);
    expect(clock.time - 1_700_000_000_000).toBeLessThan(8_000);
  });

  it("wraps a fully probed final page on the next eligible retry without an empty sweep", async () => {
    const scheduler = env.RUNNER_SCHEDULER.getByName("reconcile-cursor-wrap");
    const source = job("1100", "cf-standard-3-job-1100", "refs/pull/1100/merge");
    await scheduler.submit(source);
    await provisionRunner(scheduler, source.jobId, source.runnerName, 11_001);
    const clock = await assignmentClock(scheduler);
    let probes = 0;
    await runInDurableObject(scheduler, async (instance) => {
      instance.jobDetailOverride = async () => {
        probes += 1;
        return probes === 1
          ? { status: "queued", runner_id: null, runner_name: null }
          : { status: "in_progress", runner_id: 11_001, runner_name: source.runnerName };
      };
    });

    await expect(scheduler.cacheAssignment(source.runnerName, "biw/runner-poc")).resolves.toBeUndefined();
    await expect(scheduler.cacheAssignment(source.runnerName, "biw/runner-poc")).resolves.toBeUndefined();
    expect(probes).toBe(1);
    clock.time += 10_000;
    await expect(scheduler.cacheAssignment(source.runnerName, "biw/runner-poc")).resolves.toMatchObject({
      jobId: source.jobId,
    });
    expect(probes).toBe(2);
  });

  it("resumes the unprobed tail when the deadline interrupts a short final page", async () => {
    const scheduler = env.RUNNER_SCHEDULER.getByName("reconcile-cursor-deadline");
    const source = job("1200", "cf-standard-3-job-1200", "refs/pull/1200/merge");
    await scheduler.submit(source);
    await scheduler.submit(job("1201", "cf-standard-3-job-1201", "refs/pull/1201/merge"));
    await scheduler.submit(job("1202", "cf-standard-3-job-1202", "refs/pull/1202/merge"));
    await provisionRunner(scheduler, source.jobId, source.runnerName, 12_001);
    const clock = await assignmentClock(scheduler);
    const probes: string[] = [];
    await runInDurableObject(scheduler, async (instance) => {
      instance.jobDetailOverride = async (jobId) => {
        probes.push(jobId);
        if (probes.length === 1) {
          clock.time += 8_000;
        }
        return jobId === source.jobId
          ? { status: "in_progress", runner_id: 12_001, runner_name: source.runnerName }
          : { status: "queued", runner_id: null, runner_name: null };
      };
    });

    await expect(scheduler.cacheAssignment(source.runnerName, "biw/runner-poc")).resolves.toBeUndefined();
    expect(probes).toEqual(["1202"]);
    clock.time += 10_000;
    await expect(scheduler.cacheAssignment(source.runnerName, "biw/runner-poc")).resolves.toMatchObject({
      jobId: source.jobId,
    });
    expect(probes).toEqual(["1202", "1201", "1200"]);
  });

  it("wraps a full final page when its last probe exhausts the sweep budget", async () => {
    const scheduler = env.RUNNER_SCHEDULER.getByName("reconcile-full-final-page");
    const source = job("1250", "cf-standard-3-job-1250", "refs/pull/1250/merge");
    await scheduler.submit(source);
    for (let id = 1251; id <= 1257; id += 1) {
      // eslint-disable-next-line no-await-in-loop -- prepare exactly one full candidate page.
      await scheduler.submit(job(String(id), `cf-standard-3-job-${id}`, `refs/pull/${id}/merge`));
    }
    await provisionRunner(scheduler, source.jobId, source.runnerName, 12_501);
    const clock = await assignmentClock(scheduler);
    let probes = 0;
    await runInDurableObject(scheduler, async (instance) => {
      instance.jobDetailOverride = async (jobId) => {
        probes += 1;
        clock.time += 1_000;
        return probes > 8 && jobId === source.jobId
          ? { status: "in_progress", runner_id: 12_501, runner_name: source.runnerName }
          : { status: "queued", runner_id: null, runner_name: null };
      };
    });

    await expect(scheduler.cacheAssignment(source.runnerName, "biw/runner-poc")).resolves.toBeUndefined();
    expect(probes).toBe(8);
    clock.time += 10_000;
    await expect(scheduler.cacheAssignment(source.runnerName, "biw/runner-poc")).resolves.toMatchObject({
      jobId: source.jobId,
    });
    expect(probes).toBe(16);
  });

  it("does not spend candidate probes on stopped or releasing jobs", async () => {
    const scheduler = env.RUNNER_SCHEDULER.getByName("reconcile-terminal-candidates");
    const source = job("1300", "cf-standard-3-job-1300", "refs/pull/1300/merge");
    await scheduler.submit(source);
    await scheduler.submit(job("1301", "cf-standard-3-job-1301", "refs/pull/1301/merge"));
    await scheduler.submit(job("1302", "cf-standard-3-job-1302", "refs/pull/1302/merge"));
    await provisionRunner(scheduler, source.jobId, source.runnerName, 13_001);
    await assignmentClock(scheduler);
    const probes: string[] = [];
    await runInDurableObject(scheduler, async (instance, state) => {
      state.storage.sql.exec("UPDATE scheduler_jobs SET status = 'releasing' WHERE job_id = '1301'");
      state.storage.sql.exec("UPDATE scheduler_jobs SET status = 'stopped-awaiting-completion' WHERE job_id = '1302'");
      instance.jobDetailOverride = async (jobId) => {
        probes.push(jobId);
        return { status: "in_progress", runner_id: 13_001, runner_name: source.runnerName };
      };
    });

    await expect(scheduler.cacheAssignment(source.runnerName, "biw/runner-poc")).resolves.toMatchObject({
      jobId: source.jobId,
    });
    expect(probes).toEqual([source.jobId]);
  });

  it("does not resurrect a job completed while GitHub was being queried", async () => {
    const scheduler = env.RUNNER_SCHEDULER.getByName("reconcile-completed-during-fetch");
    const source = job("1400", "cf-standard-3-job-1400", "refs/pull/1400/merge");
    await scheduler.submit(source);
    await provisionRunner(scheduler, source.jobId, source.runnerName, 14_001);
    await assignmentClock(scheduler);
    await runInDurableObject(scheduler, async (instance) => {
      instance.jobDetailOverride = async () => {
        await instance.workflowJobCompleted(source.jobId);
        return { status: "in_progress", runner_id: 14_001, runner_name: source.runnerName };
      };
    });
    await expect(scheduler.cacheAssignment(source.runnerName, "biw/runner-poc")).resolves.toBeUndefined();
    expect((await scheduler.status()).jobs.find((entry) => entry.jobId === source.jobId)?.status).toBe("releasing");
  });

  it("uses the actual workflow run despite a larger repository backlog and persists resource attribution", async () => {
    const scheduler = env.RUNNER_SCHEDULER.getByName("workflow-run-reconcile");
    const source = { ...job("1500", "cf-standard-3-job-1500", "refs/pull/1500/merge"), installationId: undefined };
    const actual = job("1499", "cf-standard-3-job-1499", "refs/pull/1499/merge");
    await scheduler.submit(source);
    await scheduler.submit(actual);
    for (let id = 1501; id <= 1540; id += 1) {
      // eslint-disable-next-line no-await-in-loop -- populate unrelated jobs which must not consume API probes.
      await scheduler.submit(job(String(id), `cf-standard-3-job-${id}`, `refs/pull/${id}/merge`));
    }
    await provisionRunner(scheduler, source.jobId, source.runnerName, 15_001);
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
      Response.json({
        total_count: 1,
        jobs: [{ id: 1499, status: "in_progress", runner_id: 15_001, runner_name: source.runnerName }],
      }),
    );
    await assignmentClock(scheduler, fetch);

    await expect(scheduler.cacheAssignment(source.runnerName, "biw/runner-poc", "12345")).resolves.toMatchObject({
      jobId: actual.jobId,
      cacheScope: { scope: actual.cacheScope?.scope },
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://api.github.com/repos/biw/runner-poc/actions/runs/12345/jobs?filter=latest&per_page=100&page=1",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer assignment-test-token" }) }),
    );
    await expect(
      env.RESOURCE_METRICS.prepare("SELECT job_id, repository FROM resource_trace_assignments WHERE runner_name = ?")
        .bind(source.runnerName)
        .first(),
    ).resolves.toEqual({ job_id: actual.jobId, repository: "biw/runner-poc" });
  });

  it("resumes workflow-run pagination after the sweep deadline", async () => {
    const scheduler = env.RUNNER_SCHEDULER.getByName("workflow-run-pagination");
    const source = { ...job("1600", "cf-standard-3-job-1600", "refs/pull/1600/merge"), installationId: undefined };
    await scheduler.submit(source);
    await provisionRunner(scheduler, source.jobId, source.runnerName, 16_001);
    const clock = { time: 1_700_000_000_000 };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async () => {
        clock.time += 8_000;
        return Response.json({
          total_count: 101,
          jobs: Array.from({ length: 100 }, (_value, index) => ({
            id: 10_000 + index,
            status: "queued",
            runner_id: 0,
            runner_name: null,
          })),
        });
      })
      .mockImplementationOnce(async () =>
        Response.json({
          total_count: 101,
          jobs: [{ id: 1600, status: "in_progress", runner_id: 16_001, runner_name: source.runnerName }],
        }),
      );
    await runInDurableObject(scheduler, async (instance) => {
      instance.assignmentDependencies = { fetch, now: () => clock.time };
    });

    await expect(scheduler.cacheAssignment(source.runnerName, "biw/runner-poc", "12346")).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    clock.time += 10_000;
    await expect(scheduler.cacheAssignment(source.runnerName, "biw/runner-poc", "12346")).resolves.toMatchObject({
      jobId: source.jobId,
    });
    expect(fetch.mock.calls[1]?.[0]).toContain("page=2");
  });

  it.each(["repository", "profile", "terminal", "unknown", "runner-id"])(
    "rejects a workflow-run assignment with an invalid %s boundary",
    async (boundary) => {
      const scheduler = env.RUNNER_SCHEDULER.getByName(`workflow-run-boundary-${boundary}`);
      const source = { ...job("1650", "cf-standard-3-job-1650", "refs/pull/1650/merge"), installationId: undefined };
      const actual = {
        ...job("1651", "cf-standard-3-job-1651", "refs/pull/1651/merge"),
        target: boundary === "repository" ? { owner: "biw", repository: "other-repository" } : target,
        profile: boundary === "profile" ? RUNNER_PROFILES["standard-2"] : profile,
      };
      await scheduler.submit(source);
      if (boundary !== "unknown") {
        await scheduler.submit(actual);
      }
      if (boundary === "terminal") {
        await scheduler.workflowJobCompleted(actual.jobId);
      }
      await provisionRunner(scheduler, source.jobId, source.runnerName, 16_501);
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
        Response.json({
          total_count: 1,
          jobs: [
            {
              id: 1651,
              status: "in_progress",
              runner_id: boundary === "runner-id" ? 0 : 16_501,
              runner_name: source.runnerName,
            },
          ],
        }),
      );
      await assignmentClock(scheduler, fetch);

      await expect(scheduler.cacheAssignment(source.runnerName, "biw/runner-poc", "12347")).resolves.toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
      await expect(
        env.RESOURCE_METRICS.prepare("SELECT job_id FROM resource_trace_assignments WHERE runner_name = ?")
          .bind(source.runnerName)
          .first(),
      ).resolves.toBeNull();
    },
  );

  it.each(["legacy", "scoped"] as const)("releases a failed %s provisioning attempt", async (protocol) => {
    const scheduler = env.RUNNER_SCHEDULER.getByName(`compatible-failure-${protocol}`);
    const source = job("1700", "cf-standard-3-job-1700", "refs/pull/1700/merge");
    await scheduler.submit(source);
    await runInDurableObject(scheduler, async (_instance, state) => {
      state.storage.sql.exec("UPDATE scheduler_slots SET applied_max_instances = desired_max_instances");
    });
    const claim = await (protocol === "scoped"
      ? scheduler.claimProvisioning(source.jobId, source.runnerName)
      : scheduler.claimProvisioning(source.jobId));
    expect(claim).toMatchObject({ kind: "provision" });
    if (protocol === "scoped") {
      await scheduler.provisioningFailed(source.jobId, "container startup failed", source.runnerName);
    } else {
      await scheduler.provisioningFailed(source.jobId, "container startup failed");
    }
    const status = await scheduler.status();
    expect(status.jobs.find((entry) => entry.jobId === source.jobId)?.status).toBe("failed");
    expect(status.slots.find((entry) => entry.slotId === "preset:standard-3")?.reservedCount).toBe(0);
  });

  it("accepts an old two-argument failure for an already provisioning legacy retry", async () => {
    const scheduler = env.RUNNER_SCHEDULER.getByName("legacy-inflight-failure");
    const source = job("1710", "cf-standard-3-job-1710", "refs/pull/1710/merge");
    await scheduler.submit(source);
    await runInDurableObject(scheduler, async (_instance, state) => {
      // Model a persisted attempt created before workflows sent runner names.
      state.storage.sql.exec(
        "UPDATE scheduler_jobs SET status = 'provisioning', runner_name = ?, runner_attempt = 2 WHERE job_id = ?",
        `${source.runnerName}-r2`,
        source.jobId,
      );
    });

    await scheduler.provisioningFailed(source.jobId, "legacy retry failed");
    const status = await scheduler.status();
    expect(status.jobs.find((entry) => entry.jobId === source.jobId)?.status).toBe("failed");
    expect(status.slots.find((entry) => entry.slotId === "preset:standard-3")?.reservedCount).toBe(0);
  });

  it("does not let an unscoped old workflow fail a replacement owned by a new workflow", async () => {
    const scheduler = env.RUNNER_SCHEDULER.getByName("legacy-stale-failure");
    const source = job("1800", "cf-standard-3-job-1800", "refs/pull/1800/merge");
    const replacementName = `${source.runnerName}-r2`;
    await scheduler.submit(source);
    await runInDurableObject(scheduler, async (_instance, state) => {
      state.storage.sql.exec("UPDATE scheduler_slots SET applied_max_instances = desired_max_instances");
      state.storage.sql.exec(
        "UPDATE scheduler_jobs SET runner_name = ?, runner_attempt = 2 WHERE job_id = ?",
        replacementName,
        source.jobId,
      );
    });
    await expect(scheduler.claimProvisioning(source.jobId, replacementName)).resolves.toMatchObject({
      kind: "provision",
    });
    await scheduler.provisioningFailed(source.jobId, "old workflow failed");
    await expect(scheduler.canStart(source.jobId, source.runnerName)).resolves.toBe(false);
    await expect(scheduler.canStart(source.jobId, replacementName)).resolves.toBe(true);
    await expect(scheduler.claimProvisioning(source.jobId, source.runnerName)).resolves.toEqual({ kind: "cancelled" });
    expect((await scheduler.status()).jobs.find((entry) => entry.jobId === source.jobId)?.status).toBe("provisioning");
    await scheduler.provisioningFailed(source.jobId, "current workflow failed", replacementName);
    expect((await scheduler.status()).jobs.find((entry) => entry.jobId === source.jobId)?.status).toBe("failed");
  });
});
