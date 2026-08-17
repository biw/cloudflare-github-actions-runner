import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import { prepareRunnerApplication, reconcileRunnerApplicationCapacity } from "./cloudflare-containers";
import type { WorkerEnvironment } from "./environment";
import { githubRunnerTokenFor, type GitHubRepositoryTarget } from "./github-repository";
import { githubTokenForRunner } from "./github-app";
import { deleteGitHubRunner } from "./provision";
import {
  runnerProfileSchema,
  RUNNER_PROFILE_KEYS,
  RUNNER_PROFILES,
  type RunnerProfile,
  type RunnerProfileKey,
} from "./runner-profiles";
import {
  DEFAULT_ACCOUNT_CAPACITY,
  capacityDebounceDeadline,
  configuredCapacity,
  fitsAccountCapacity,
  planConfiguredCapacity,
  requiredMaxInstances,
  selectCustomSlot,
  type ConfiguredCapacityPlan,
  type ConfiguredCapacitySlot,
} from "./scheduler-policy";

const SCHEDULER_ALARM_DELAY_MS = 60_000;
const RUNNER_COMPLETION_GRACE_MS = 30_000;
// GitHub can deliver workflow_job: completed before actions/cache finishes its
// post-job upload through the runner's local results proxy. Keep the one-job
// runner-to-cache mapping briefly after Container shutdown for that finalizer.
const RUNNER_CACHE_POST_JOB_GRACE_MS = 5 * 60_000;
const RUNNER_CLEANUP_RETRY_MS = 60_000;
const STALLED_CAPACITY_UPDATE_RECOVERY_MS = 60_000;
const ACTIVE_JOB_STATES = ["admitted", "provisioning", "running", "releasing", "stopped-awaiting-completion"] as const;

type JobStatus =
  | "queued"
  | "admitted"
  | "provisioning"
  | "running"
  | "releasing"
  | "stopped-awaiting-completion"
  | "completed"
  | "cancelled"
  | "failed";

const activeJobStates = new Set<JobStatus>(ACTIVE_JOB_STATES);

type SlotConfigurationState = "ready" | "configuring" | "idle";

type SchedulerEventDetailScalar = boolean | number | string | null;
type SchedulerEventDetailValue = SchedulerEventDetailScalar | readonly SchedulerEventDetailScalar[];

interface SchedulerEventDetail {
  readonly [property: string]: SchedulerEventDetailValue | undefined;
}

type SchedulerEventData = SchedulerEventDetail | string | null;

const schedulerEventDetailSchema = z.union([
  z.string(),
  z.null(),
  z.record(
    z.string(),
    z.union([
      z.boolean(),
      z.number(),
      z.string(),
      z.null(),
      z.array(z.union([z.boolean(), z.number(), z.string(), z.null()])),
    ]),
  ),
]);

interface JobRow {
  [column: string]: ArrayBuffer | number | string | null;
  job_id: string;
  runner_name: string;
  github_owner: string;
  github_repository: string;
  head_sha: string;
  worker_origin: string;
  github_installation_id: number | null;
  cache_scope: string;
  cache_fallback_scope: string | null;
  cache_write_allowed: number;
  github_assignment_observed: number;
  profile_json: string;
  profile_key: string;
  vcpu: number;
  memory_mib: number;
  disk_mb: number;
  status: JobStatus;
  slot_id: string | null;
  created_at: number;
  updated_at: number;
  runner_id: number | null;
  runner_attempt: number;
  failure_reason: string | null;
  container_stopped_at: number | null;
  container_exit_code: number | null;
  container_stop_reason: string | null;
  recovery_due_at: number | null;
  runner_cleanup_state: "none" | "retry" | "done";
  runner_cleanup_due_at: number | null;
  runner_cleanup_attempts: number;
}

interface SlotRow {
  [column: string]: ArrayBuffer | number | string | null;
  slot_id: string;
  application_name: string;
  kind: "preset" | "custom";
  profile_key: string | null;
  vcpu: number | null;
  memory_mib: number | null;
  disk_mb: number | null;
  configuration_state: SlotConfigurationState;
  configuration_owner_job_id: string | null;
  reserved_count: number;
  desired_max_instances: number;
  applied_max_instances: number;
  capacity_debounce_until: number;
  capacity_update_in_progress: number;
  capacity_update_generation: number;
  pending_profile_key: string | null;
  pending_vcpu: number | null;
  pending_memory_mib: number | null;
  pending_disk_mb: number | null;
  capacity_reclaim_pending: number;
  last_released_at: number;
  capacity_generation: number;
}

interface SchedulerEventRow {
  [column: string]: ArrayBuffer | number | string | null;
  event_id: number;
  job_id: string | null;
  slot_id: string | null;
  kind: string;
  detail_json: string | null;
  created_at: number;
}

/**
 * A JIT runner has a durable identity of its own. Keep it separate from its
 * source job: GitHub may assign two compatible runners to each other's jobs,
 * and processing one assignment must not erase the other runner's mapping.
 */
interface JitRunnerRow {
  [column: string]: ArrayBuffer | number | string | null;
  runner_name: string;
  source_job_id: string;
  github_owner: string;
  github_repository: string;
  profile_key: string;
  assigned_job_id: string | null;
  assignment_observed: number;
  created_at: number;
  updated_at: number;
}

interface ResourceTotals {
  vcpu: number;
  memoryMib: number;
  diskMb: number;
}

export interface SchedulerJobInput {
  jobId: string;
  headSha: string;
  runnerName: string;
  target: GitHubRepositoryTarget;
  installationId?: number;
  profile: RunnerProfile;
  workerOrigin: string;
  /** GitHub-compatible cache visibility resolved from the signed workflow run. */
  cacheScope?: SchedulerCacheScope;
}

export interface SchedulerCacheScope {
  scope: string;
  fallbackScope?: string;
  writeAllowed: boolean;
}

export interface SchedulerAdmission {
  jobId: string;
  runnerName: string;
  workflowId: string;
}

export interface SchedulerResult {
  accepted: boolean;
  queueReason?: string;
  admissions: SchedulerAdmission[];
}

export interface SchedulerRunnerClaimInput {
  jobId: string;
  runnerName: string;
  runnerId?: number;
  target: GitHubRepositoryTarget;
  profile: RunnerProfile;
}

export interface RunnerProvisioningPlan {
  kind: "provision";
  jobId: string;
  headSha: string;
  runnerName: string;
  target: GitHubRepositoryTarget;
  workerOrigin: string;
  cacheScope?: SchedulerCacheScope;
  installationId: number | null;
  profile: RunnerProfile;
  slotId: string;
  applicationName: string;
  requiredMaxInstances: number;
  capacityGeneration: number;
  requiresConfiguration: boolean;
}

export type SchedulerProvisioningClaim =
  | { kind: "wait" }
  | { kind: "cancelled" }
  | { kind: "missing" }
  | RunnerProvisioningPlan;

export interface SchedulerStatus {
  capacity: {
    limit: ResourceTotals;
    reserved: ResourceTotals;
    configured: ResourceTotals;
  };
  jobs: Array<{
    jobId: string;
    runnerName: string;
    repository: string;
    profileKey: string;
    status: JobStatus;
    slotId: string | null;
    queueWaitMs: number | null;
    runnerId: number | null;
    containerStoppedAt: number | null;
    containerExitCode: number | null;
    containerStopReason: string | null;
    recoveryDueAt: number | null;
    runnerCleanupState: "none" | "retry" | "done";
  }>;
  slots: Array<{
    slotId: string;
    applicationName: string;
    kind: "preset" | "custom";
    profileKey: string | null;
    configurationState: SlotConfigurationState;
    reservedCount: number;
    desiredMaxInstances: number;
    appliedMaxInstances: number;
    capacityDebounceUntil: number | null;
    capacityUpdateInProgress: boolean;
    pendingProfileKey: string | null;
    capacityReclaimPending: boolean;
    lastReleasedAt: number | null;
  }>;
  events: Array<{
    eventId: number;
    jobId: string | null;
    slotId: string | null;
    kind: string;
    detail: SchedulerEventData;
    createdAt: number;
  }>;
}

function now(): number {
  return Date.now();
}

function customApplicationName(env: WorkerEnvironment, slotNumber: number): string {
  return slotNumber === 1 ? env.CUSTOM_RUNNER_APPLICATION : `${env.CUSTOM_RUNNER_APPLICATION}-${slotNumber}`;
}

function presetApplicationName(env: WorkerEnvironment, key: RunnerProfileKey): string {
  const suffix = {
    lite: "githubactionsrunnerlite",
    basic: "githubactionsrunnerbasic",
    "standard-1": "githubactionsrunnerstandard1",
    "standard-2": "githubactionsrunnerstandard2",
    "standard-3": "githubactionsrunner",
    "standard-4": "githubactionsrunnerstandard4",
  } satisfies Readonly<Record<RunnerProfileKey, string>>;
  return `${env.RUNNER_APPLICATION_PREFIX}-${suffix[key]}`;
}

function parseProfile(value: string): RunnerProfile {
  return runnerProfileSchema.parse(JSON.parse(value));
}

function parseEventDetail(value: string | null): SchedulerEventData {
  if (value === null) {
    return null;
  }
  try {
    const parsed = schedulerEventDetailSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : value;
  } catch {
    return value;
  }
}

function activeStatusList(): string {
  return ACTIVE_JOB_STATES.map(() => "?").join(", ");
}

function storedCacheScope(scope: string, fallbackScope: string | null, writeAllowed: number): SchedulerCacheScope {
  const result: SchedulerCacheScope = { scope, writeAllowed: writeAllowed !== 0 };
  if (fallbackScope !== null) {
    result.fallbackScope = fallbackScope;
  }
  return result;
}

function isSlotConfigurationState(value: string): value is SlotConfigurationState {
  return value === "ready" || value === "configuring" || value === "idle";
}

function jobMatchesRunnerClaim(job: JobRow, input: SchedulerRunnerClaimInput): boolean {
  return (
    job.github_owner.toLowerCase() === input.target.owner.toLowerCase() &&
    job.github_repository.toLowerCase() === input.target.repository.toLowerCase() &&
    job.profile_key === input.profile.key
  );
}

/**
 * One scheduler exists per Cloudflare account. The account is deliberately the
 * coordination atom: all capacity reservations for this runner service live in
 * one SQLite-backed Durable Object. Its alarm serializes Cloudflare capacity
 * mutations, while Workflows handle only runner start and rollout polling.
 */
export class AccountRunnerScheduler extends DurableObject<WorkerEnvironment> {
  constructor(ctx: DurableObjectState, env: WorkerEnvironment) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.initializeSchema();
      this.initializeSlots();
      this.reconcileSlotReservations();
      this.releaseCompletedJobsAwaitingContainerStop();
      this.scheduleReleaseRecoveries();
      this.recoverStalledCapacityUpdates();
      // A Worker deployment can reset an in-flight scheduler invocation. Re-arm
      // the persisted alarm while reconstructing the DO so queued capacity
      // changes and recovery work continue without another GitHub delivery.
      await this.scheduleWorkAlarmIfNeeded();
    });
  }

  private initializeSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_jobs (
        job_id TEXT PRIMARY KEY,
        runner_name TEXT NOT NULL,
        github_owner TEXT NOT NULL DEFAULT '',
        github_repository TEXT NOT NULL DEFAULT '',
        head_sha TEXT NOT NULL DEFAULT '',
        worker_origin TEXT NOT NULL DEFAULT '',
        github_installation_id INTEGER,
        cache_scope TEXT NOT NULL DEFAULT '',
        cache_fallback_scope TEXT,
        cache_write_allowed INTEGER NOT NULL DEFAULT 0,
        github_assignment_observed INTEGER NOT NULL DEFAULT 0,
        profile_json TEXT NOT NULL,
        profile_key TEXT NOT NULL,
        vcpu REAL NOT NULL,
        memory_mib INTEGER NOT NULL,
        disk_mb INTEGER NOT NULL,
        status TEXT NOT NULL,
        slot_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        runner_id INTEGER,
        runner_attempt INTEGER NOT NULL DEFAULT 1,
        failure_reason TEXT,
        container_stopped_at INTEGER,
        container_exit_code INTEGER,
        container_stop_reason TEXT,
        recovery_due_at INTEGER,
        runner_cleanup_state TEXT NOT NULL DEFAULT 'none',
        runner_cleanup_due_at INTEGER,
        runner_cleanup_attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS scheduler_jobs_queue ON scheduler_jobs(status, created_at, job_id);
      CREATE INDEX IF NOT EXISTS scheduler_jobs_runner ON scheduler_jobs(runner_name);
      CREATE TABLE IF NOT EXISTS scheduler_slots (
        slot_id TEXT PRIMARY KEY,
        application_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        profile_key TEXT,
        vcpu REAL,
        memory_mib INTEGER,
        disk_mb INTEGER,
        configuration_state TEXT NOT NULL,
        configuration_owner_job_id TEXT,
        reserved_count INTEGER NOT NULL,
        desired_max_instances INTEGER NOT NULL,
        applied_max_instances INTEGER NOT NULL DEFAULT 1,
        capacity_debounce_until INTEGER NOT NULL DEFAULT 0,
        capacity_update_in_progress INTEGER NOT NULL DEFAULT 0,
        capacity_update_generation INTEGER NOT NULL DEFAULT 0,
        pending_profile_key TEXT,
        pending_vcpu REAL,
        pending_memory_mib INTEGER,
        pending_disk_mb INTEGER,
        capacity_reclaim_pending INTEGER NOT NULL DEFAULT 0,
        last_released_at INTEGER NOT NULL DEFAULT 0,
        capacity_generation INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS capacity_operations (
        slot_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        target_max_instances INTEGER NOT NULL,
        state TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(slot_id, generation)
      );
      CREATE TABLE IF NOT EXISTS scheduler_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT,
        slot_id TEXT,
        kind TEXT NOT NULL,
        detail_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS scheduler_events_recent ON scheduler_events(created_at DESC, event_id DESC);
      CREATE TABLE IF NOT EXISTS scheduler_jit_runners (
        runner_name TEXT PRIMARY KEY,
        source_job_id TEXT NOT NULL,
        github_owner TEXT NOT NULL,
        github_repository TEXT NOT NULL,
        profile_key TEXT NOT NULL,
        assigned_job_id TEXT,
        assignment_observed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS scheduler_jit_runners_assignment
        ON scheduler_jit_runners(assigned_job_id, assignment_observed, updated_at);
    `);

    const columns = this.rows<{ name: string }>("PRAGMA table_info(scheduler_slots)");
    if (!columns.some((column) => column.name === "applied_max_instances")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE scheduler_slots ADD COLUMN applied_max_instances INTEGER NOT NULL DEFAULT 1",
      );
    }
    if (!columns.some((column) => column.name === "capacity_debounce_until")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE scheduler_slots ADD COLUMN capacity_debounce_until INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!columns.some((column) => column.name === "capacity_update_in_progress")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE scheduler_slots ADD COLUMN capacity_update_in_progress INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!columns.some((column) => column.name === "capacity_update_generation")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE scheduler_slots ADD COLUMN capacity_update_generation INTEGER NOT NULL DEFAULT 0",
      );
    }
    const slotColumnMigrations = [
      ["pending_profile_key", "TEXT"],
      ["pending_vcpu", "REAL"],
      ["pending_memory_mib", "INTEGER"],
      ["pending_disk_mb", "INTEGER"],
      ["capacity_reclaim_pending", "INTEGER NOT NULL DEFAULT 0"],
      ["last_released_at", "INTEGER NOT NULL DEFAULT 0"],
    ] as const;
    for (const [name, definition] of slotColumnMigrations) {
      if (!columns.some((column) => column.name === name)) {
        this.ctx.storage.sql.exec(`ALTER TABLE scheduler_slots ADD COLUMN ${name} ${definition}`);
      }
    }

    const jobColumns = this.rows<{ name: string }>("PRAGMA table_info(scheduler_jobs)");
    const jobColumnMigrations = [
      ["github_owner", "TEXT NOT NULL DEFAULT ''"],
      ["github_repository", "TEXT NOT NULL DEFAULT ''"],
      ["head_sha", "TEXT NOT NULL DEFAULT ''"],
      ["worker_origin", "TEXT NOT NULL DEFAULT ''"],
      ["github_installation_id", "INTEGER"],
      ["cache_scope", "TEXT NOT NULL DEFAULT ''"],
      ["cache_fallback_scope", "TEXT"],
      ["cache_write_allowed", "INTEGER NOT NULL DEFAULT 0"],
      ["github_assignment_observed", "INTEGER NOT NULL DEFAULT 0"],
      ["runner_attempt", "INTEGER NOT NULL DEFAULT 1"],
      ["container_stopped_at", "INTEGER"],
      ["container_exit_code", "INTEGER"],
      ["container_stop_reason", "TEXT"],
      ["recovery_due_at", "INTEGER"],
      ["runner_cleanup_state", "TEXT NOT NULL DEFAULT 'none'"],
      ["runner_cleanup_due_at", "INTEGER"],
      ["runner_cleanup_attempts", "INTEGER NOT NULL DEFAULT 0"],
    ] as const;
    for (const [name, definition] of jobColumnMigrations) {
      if (!jobColumns.some((column) => column.name === name)) {
        this.ctx.storage.sql.exec(`ALTER TABLE scheduler_jobs ADD COLUMN ${name} ${definition}`);
      }
    }
    // Jobs that were queued before the pool became multi-repository belong to
    // the original POC repository and must retain a usable cleanup credential.
    if (this.env.LEGACY_GITHUB_OWNER !== undefined && this.env.LEGACY_GITHUB_REPOSITORY !== undefined) {
      this.ctx.storage.sql.exec(
        `UPDATE scheduler_jobs
         SET github_owner = ?, github_repository = ?
         WHERE github_owner = '' AND github_repository = ''`,
        this.env.LEGACY_GITHUB_OWNER,
        this.env.LEGACY_GITHUB_REPOSITORY,
      );
    }
  }

  private initializeSlots(): void {
    for (const key of RUNNER_PROFILE_KEYS) {
      const profile = RUNNER_PROFILES[key];
      this.insertSlot({
        slotId: `preset:${key}`,
        applicationName: presetApplicationName(this.env, key),
        kind: "preset",
        profileKey: key,
        vcpu: profile.vcpu,
        memoryMib: profile.memoryMib,
        diskMb: profile.diskMb,
        configurationState: "ready",
      });
    }

    for (let slotNumber = 1; slotNumber <= 10; slotNumber += 1) {
      this.insertSlot({
        slotId: `custom:${slotNumber}`,
        applicationName: customApplicationName(this.env, slotNumber),
        kind: "custom",
        profileKey: null,
        vcpu: null,
        memoryMib: null,
        diskMb: null,
        configurationState: "idle",
      });
    }
  }

  private insertSlot(slot: {
    slotId: string;
    applicationName: string;
    kind: "preset" | "custom";
    profileKey: string | null;
    vcpu: number | null;
    memoryMib: number | null;
    diskMb: number | null;
    configurationState: SlotConfigurationState;
  }): void {
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO scheduler_slots
       (slot_id, application_name, kind, profile_key, vcpu, memory_mib, disk_mb,
        configuration_state, configuration_owner_job_id, reserved_count, desired_max_instances,
        applied_max_instances, capacity_debounce_until, capacity_update_in_progress, capacity_update_generation,
        pending_profile_key, pending_vcpu, pending_memory_mib, pending_disk_mb, capacity_reclaim_pending,
        last_released_at, capacity_generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 1, 1, 0, 0, 0, NULL, NULL, NULL, NULL, 0, 0, 0)`,
      slot.slotId,
      slot.applicationName,
      slot.kind,
      slot.profileKey,
      slot.vcpu,
      slot.memoryMib,
      slot.diskMb,
      slot.configurationState,
    );
  }

  private rows<T extends Record<string, ArrayBuffer | number | string | null>>(
    statement: string,
    ...bindings: unknown[]
  ): T[] {
    return this.ctx.storage.sql.exec<T>(statement, ...bindings).toArray();
  }

  private recordEvent(
    kind: string,
    options: { jobId?: string; slotId?: string; detail?: SchedulerEventDetail } = {},
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO scheduler_events (job_id, slot_id, kind, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      options.jobId ?? null,
      options.slotId ?? null,
      kind,
      options.detail === undefined ? null : JSON.stringify(options.detail),
      now(),
    );
  }

  private job(jobId: string): JobRow | undefined {
    return this.rows<JobRow>("SELECT * FROM scheduler_jobs WHERE job_id = ?", jobId)[0];
  }

  private slot(slotId: string): SlotRow | undefined {
    return this.rows<SlotRow>("SELECT * FROM scheduler_slots WHERE slot_id = ?", slotId)[0];
  }

  private reservedResources(): ResourceTotals {
    const row = this.rows<{ vcpu: number | null; memory_mib: number | null; disk_mb: number | null }>(
      `SELECT COALESCE(SUM(vcpu), 0) AS vcpu,
              COALESCE(SUM(memory_mib), 0) AS memory_mib,
              COALESCE(SUM(disk_mb), 0) AS disk_mb
       FROM scheduler_jobs WHERE status IN (${activeStatusList()})`,
      ...ACTIVE_JOB_STATES,
    )[0];
    return {
      vcpu: row?.vcpu ?? 0,
      memoryMib: row?.memory_mib ?? 0,
      diskMb: row?.disk_mb ?? 0,
    };
  }

  private canReserve(profile: RunnerProfile): boolean {
    return fitsAccountCapacity(this.reservedResources(), profile, DEFAULT_ACCOUNT_CAPACITY);
  }

  private configuredCapacitySlots(): ConfiguredCapacitySlot[] {
    return this.rows<SlotRow>("SELECT * FROM scheduler_slots").map((slot) => ({
      slotId: slot.slot_id,
      resources:
        slot.vcpu === null || slot.memory_mib === null || slot.disk_mb === null
          ? null
          : { vcpu: slot.vcpu, memoryMib: slot.memory_mib, diskMb: slot.disk_mb },
      appliedMaxInstances: slot.applied_max_instances,
      reservedCount: slot.reserved_count,
      configurationState: isSlotConfigurationState(slot.configuration_state) ? slot.configuration_state : "idle",
      capacityUpdateInProgress: slot.capacity_update_in_progress !== 0,
      lastReleasedAt: slot.last_released_at,
    }));
  }

  private configuredResources(): ResourceTotals {
    return configuredCapacity(this.configuredCapacitySlots());
  }

  private capacityPlan(
    slot: SlotRow,
    profile: RunnerProfile,
    targetMaxInstances: number,
  ): ConfiguredCapacityPlan | undefined {
    return planConfiguredCapacity(
      this.configuredCapacitySlots(),
      {
        slotId: slot.slot_id,
        resources: { vcpu: profile.vcpu, memoryMib: profile.memoryMib, diskMb: profile.diskMb },
        maxInstances: targetMaxInstances,
      },
      DEFAULT_ACCOUNT_CAPACITY,
    );
  }

  private selectSlot(profile: RunnerProfile): { slot: SlotRow; requiresConfiguration: boolean } | undefined {
    if (profile.kind === "preset") {
      const slot = this.slot(`preset:${profile.key}`);
      return slot === undefined ? undefined : { slot, requiresConfiguration: false };
    }

    const candidates = this.rows<SlotRow>("SELECT * FROM scheduler_slots WHERE kind = 'custom'");
    const selected = selectCustomSlot(
      profile,
      candidates.map((slot) => ({
        slotId: slot.slot_id,
        profileKey: slot.configuration_state === "configuring" ? slot.pending_profile_key : slot.profile_key,
        configurationState: isSlotConfigurationState(slot.configuration_state) ? slot.configuration_state : "idle",
        reservedCount: slot.reserved_count,
      })),
    );
    if (selected === undefined) {
      return undefined;
    }
    const slot = candidates.find((candidate) => candidate.slot_id === selected.slotId);
    return slot === undefined ? undefined : { slot, requiresConfiguration: selected.requiresConfiguration };
  }

  private admissionFor(job: JobRow): SchedulerAdmission {
    return {
      jobId: job.job_id,
      runnerName: job.runner_name,
      workflowId: `${job.job_id}-attempt-${job.runner_attempt}`,
    };
  }

  private readyAdmissions(): SchedulerAdmission[] {
    return this.rows<JobRow>(
      `SELECT scheduler_jobs.*
       FROM scheduler_jobs
       INNER JOIN scheduler_slots ON scheduler_slots.slot_id = scheduler_jobs.slot_id
       WHERE scheduler_jobs.status = 'admitted'
         AND scheduler_slots.configuration_state = 'ready'
         AND scheduler_slots.capacity_update_in_progress = 0
         AND scheduler_slots.applied_max_instances >= scheduler_slots.desired_max_instances
       ORDER BY scheduler_jobs.created_at ASC, scheduler_jobs.job_id ASC`,
    ).map((job) => this.admissionFor(job));
  }

  private recordCapacityOperation(
    slotId: string,
    generation: number,
    targetMaxInstances: number,
    timestamp: number,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO capacity_operations (slot_id, generation, target_max_instances, state, updated_at)
       VALUES (?, ?, ?, 'pending', ?)
       ON CONFLICT(slot_id, generation) DO UPDATE SET target_max_instances = excluded.target_max_instances,
         state = 'pending', updated_at = excluded.updated_at`,
      slotId,
      generation,
      targetMaxInstances,
      timestamp,
    );
  }

  private targetMaxInstances(slot: SlotRow, requiresConfiguration: boolean): number {
    const required = requiredMaxInstances(slot.reserved_count);
    return requiresConfiguration || slot.configuration_state === "configuring"
      ? required
      : Math.max(slot.applied_max_instances, required);
  }

  private scheduleCapacityReclamation(
    reductions: readonly { slotId: string; targetMaxInstances: number }[],
    timestamp: number,
  ): void {
    for (const reduction of reductions) {
      const donor = this.slot(reduction.slotId);
      if (
        donor === undefined ||
        donor.configuration_state !== "ready" ||
        donor.reserved_count !== 0 ||
        donor.capacity_update_in_progress !== 0 ||
        reduction.targetMaxInstances >= donor.applied_max_instances
      ) {
        continue;
      }
      const generation = donor.capacity_generation + 1;
      this.ctx.storage.sql.exec(
        `UPDATE scheduler_slots
         SET desired_max_instances = ?, capacity_debounce_until = 0, capacity_generation = ?
         WHERE slot_id = ?`,
        reduction.targetMaxInstances,
        generation,
        donor.slot_id,
      );
      this.recordCapacityOperation(donor.slot_id, generation, reduction.targetMaxInstances, timestamp);
      this.recordEvent("capacity-reclamation-planned", {
        slotId: donor.slot_id,
        detail: { from: donor.applied_max_instances, to: reduction.targetMaxInstances },
      });
    }
  }

  private admitNext(): SchedulerAdmission[] {
    const next = this.rows<JobRow>(
      "SELECT * FROM scheduler_jobs WHERE status = 'queued' ORDER BY created_at ASC, job_id ASC LIMIT 1",
    )[0];
    if (next === undefined) {
      return [];
    }

    const profile = parseProfile(next.profile_json);
    if (!this.canReserve(profile)) {
      return [];
    }

    const selected = this.selectSlot(profile);
    if (selected === undefined) {
      return [];
    }

    const nextReservedCount = selected.slot.reserved_count + 1;
    const targetMaxInstances = this.targetMaxInstances(selected.slot, selected.requiresConfiguration);
    const capacityPlan = this.capacityPlan(selected.slot, profile, targetMaxInstances);
    if (capacityPlan === undefined) {
      return [];
    }

    const timestamp = now();
    this.scheduleCapacityReclamation(capacityPlan.reductions, timestamp);
    const nextGeneration = selected.slot.capacity_generation + 1;
    const configuring = selected.requiresConfiguration || selected.slot.configuration_state === "configuring";
    const capacityIncreaseRequired = !configuring && targetMaxInstances > selected.slot.applied_max_instances;
    const requiresDeferredCapacity =
      configuring ||
      selected.slot.capacity_update_in_progress !== 0 ||
      capacityIncreaseRequired ||
      capacityPlan.reductions.length > 0;
    const capacityDebounceUntil = configuring
      ? 0
      : capacityIncreaseRequired || selected.slot.capacity_update_in_progress !== 0
        ? capacityDebounceDeadline(timestamp)
        : selected.slot.capacity_debounce_until;
    this.ctx.storage.sql.exec(
      `UPDATE scheduler_slots
       SET profile_key = ?, vcpu = ?, memory_mib = ?, disk_mb = ?, configuration_state = ?,
           configuration_owner_job_id = ?, reserved_count = ?, desired_max_instances = ?,
           capacity_debounce_until = ?, pending_profile_key = ?, pending_vcpu = ?, pending_memory_mib = ?,
           pending_disk_mb = ?, capacity_reclaim_pending = ?, capacity_generation = ?
       WHERE slot_id = ?`,
      configuring ? selected.slot.profile_key : profile.key,
      configuring ? selected.slot.vcpu : profile.vcpu,
      configuring ? selected.slot.memory_mib : profile.memoryMib,
      configuring ? selected.slot.disk_mb : profile.diskMb,
      configuring ? "configuring" : selected.slot.configuration_state,
      selected.requiresConfiguration ? next.job_id : selected.slot.configuration_owner_job_id,
      nextReservedCount,
      targetMaxInstances,
      capacityDebounceUntil,
      configuring ? profile.key : null,
      configuring ? profile.vcpu : null,
      configuring ? profile.memoryMib : null,
      configuring ? profile.diskMb : null,
      configuring && capacityPlan.reductions.length > 0 ? 1 : 0,
      nextGeneration,
      selected.slot.slot_id,
    );
    if (capacityIncreaseRequired || configuring || selected.slot.capacity_update_in_progress !== 0) {
      this.recordCapacityOperation(selected.slot.slot_id, nextGeneration, targetMaxInstances, timestamp);
    }
    this.ctx.storage.sql.exec(
      "UPDATE scheduler_jobs SET status = 'admitted', slot_id = ?, updated_at = ? WHERE job_id = ?",
      selected.slot.slot_id,
      timestamp,
      next.job_id,
    );
    this.recordEvent("scheduler-admitted", {
      jobId: next.job_id,
      slotId: selected.slot.slot_id,
      detail: {
        desiredMaxInstances: targetMaxInstances,
        appliedMaxInstances: selected.slot.applied_max_instances,
        deferredForCapacity: requiresDeferredCapacity,
        reclaimedSlots: capacityPlan.reductions.map((reduction) => reduction.slotId),
      },
    });
    return selected.requiresConfiguration || !requiresDeferredCapacity ? [this.admissionFor(next)] : [];
  }

  private queueReason(job: JobRow): string | undefined {
    if (job.status !== "queued") {
      return undefined;
    }
    const profile = parseProfile(job.profile_json);
    if (!this.canReserve(profile)) {
      return "waiting-for-account-resource-budget";
    }
    const selected = this.selectSlot(profile);
    if (profile.kind === "custom" && selected === undefined) {
      return "waiting-for-idle-custom-slot";
    }
    if (selected !== undefined) {
      const targetMaxInstances = this.targetMaxInstances(selected.slot, selected.requiresConfiguration);
      if (this.capacityPlan(selected.slot, profile, targetMaxInstances) === undefined) {
        return "waiting-for-retained-capacity-reclamation";
      }
    }
    return "waiting-for-earlier-queued-job";
  }

  private async scheduleWorkAlarmIfNeeded(): Promise<void> {
    const work = this.rows<{ count: number }>(
      "SELECT COUNT(*) AS count FROM scheduler_jobs WHERE status IN ('queued', 'admitted')",
    )[0];
    const capacityChange = this.rows<{ earliest_due: number | null }>(
      `SELECT MIN(capacity_debounce_until) AS earliest_due
       FROM scheduler_slots
       WHERE configuration_state = 'ready'
         AND capacity_update_in_progress = 0
         AND desired_max_instances != applied_max_instances`,
    )[0];
    const recovery = this.rows<{ earliest_due: number | null }>(
      `SELECT MIN(due_at) AS earliest_due
       FROM (
         SELECT recovery_due_at AS due_at
         FROM scheduler_jobs
         WHERE status = 'stopped-awaiting-completion' AND recovery_due_at IS NOT NULL
         UNION ALL
         SELECT runner_cleanup_due_at AS due_at
         FROM scheduler_jobs
         WHERE runner_cleanup_state = 'retry' AND runner_cleanup_due_at IS NOT NULL
         UNION ALL
         SELECT recovery_due_at AS due_at
         FROM scheduler_jobs
         WHERE status = 'releasing' AND recovery_due_at IS NOT NULL
       )`,
    )[0];
    const recoveryDue = (work?.count ?? 0) > 0 ? now() + SCHEDULER_ALARM_DELAY_MS : undefined;
    const scheduledDue = [capacityChange?.earliest_due, recovery?.earliest_due, recoveryDue].filter(
      (due): due is number => due !== null && due !== undefined,
    );
    const nextAlarm = scheduledDue.length === 0 ? undefined : Math.max(now(), Math.min(...scheduledDue));
    if (nextAlarm !== undefined) {
      await this.ctx.storage.setAlarm(nextAlarm);
    }
  }

  async submit(job: SchedulerJobInput): Promise<SchedulerResult> {
    const existing = this.job(job.jobId);
    if (existing !== undefined) {
      if (existing.head_sha === "" && job.headSha !== "") {
        this.ctx.storage.sql.exec(
          "UPDATE scheduler_jobs SET head_sha = ?, updated_at = ? WHERE job_id = ? AND head_sha = ''",
          job.headSha,
          now(),
          job.jobId,
        );
      }
      return { accepted: true, queueReason: this.queueReason(existing), admissions: [] };
    }

    const timestamp = now();
    this.ctx.storage.sql.exec(
      `INSERT INTO scheduler_jobs
       (job_id, runner_name, github_owner, github_repository, head_sha, worker_origin, github_installation_id, cache_scope, cache_fallback_scope, cache_write_allowed, profile_json, profile_key, vcpu, memory_mib, disk_mb, status,
        slot_id, created_at, updated_at, runner_id, runner_attempt, failure_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?, NULL, 1, NULL)`,
      job.jobId,
      job.runnerName,
      job.target.owner,
      job.target.repository,
      job.headSha,
      job.workerOrigin,
      job.installationId ?? null,
      job.cacheScope?.scope ?? "",
      job.cacheScope?.fallbackScope ?? null,
      job.cacheScope?.writeAllowed === true ? 1 : 0,
      JSON.stringify(job.profile),
      job.profile.key,
      job.profile.vcpu,
      job.profile.memoryMib,
      job.profile.diskMb,
      timestamp,
      timestamp,
    );
    this.recordEvent("github-job-queued", {
      jobId: job.jobId,
      detail: {
        repository: `${job.target.owner}/${job.target.repository}`,
        headSha: job.headSha,
        installationId: job.installationId ?? null,
        cacheScope: job.cacheScope?.scope ?? null,
        cacheFallbackScope: job.cacheScope?.fallbackScope ?? null,
        cacheWriteAllowed: job.cacheScope?.writeAllowed === true,
        profileKey: job.profile.key,
        runnerName: job.runnerName,
      },
    });

    const admissions = this.admitNext();
    await this.scheduleWorkAlarmIfNeeded();
    const stored = this.job(job.jobId);
    return { accepted: true, queueReason: stored === undefined ? undefined : this.queueReason(stored), admissions };
  }

  async claimProvisioning(jobId: string): Promise<SchedulerProvisioningClaim> {
    const job = this.job(jobId);
    if (job === undefined) {
      return { kind: "missing" };
    }
    if (job.status === "queued" || job.status === "admitted") {
      if (job.slot_id === null) {
        return { kind: "wait" };
      }
      const slot = this.slot(job.slot_id);
      if (slot === undefined) {
        return { kind: "missing" };
      }
      if (slot.configuration_state === "configuring" && slot.configuration_owner_job_id !== jobId) {
        return { kind: "wait" };
      }
      const ownsConfiguration = slot.configuration_state === "configuring" && slot.configuration_owner_job_id === jobId;
      if (
        slot.capacity_reclaim_pending !== 0 ||
        slot.capacity_update_in_progress !== 0 ||
        (!ownsConfiguration && slot.applied_max_instances < slot.desired_max_instances)
      ) {
        return { kind: "wait" };
      }
      this.ctx.storage.sql.exec(
        "UPDATE scheduler_jobs SET status = 'provisioning', updated_at = ? WHERE job_id = ?",
        now(),
        jobId,
      );
      const profile = parseProfile(job.profile_json);
      return {
        kind: "provision",
        jobId,
        headSha: job.head_sha,
        runnerName: job.runner_name,
        target: { owner: job.github_owner, repository: job.github_repository },
        workerOrigin: job.worker_origin,
        cacheScope:
          job.cache_scope === ""
            ? undefined
            : storedCacheScope(job.cache_scope, job.cache_fallback_scope, job.cache_write_allowed),
        installationId: job.github_installation_id,
        profile,
        slotId: slot.slot_id,
        applicationName: slot.application_name,
        requiredMaxInstances: Math.max(1, slot.reserved_count),
        capacityGeneration: slot.capacity_generation,
        requiresConfiguration: slot.configuration_state === "configuring" && slot.configuration_owner_job_id === jobId,
      };
    }
    if (job.status === "provisioning" || job.status === "running") {
      if (job.slot_id === null) {
        return { kind: "missing" };
      }
      const slot = this.slot(job.slot_id);
      if (slot === undefined) {
        return { kind: "missing" };
      }
      if (
        slot.capacity_reclaim_pending !== 0 ||
        slot.capacity_update_in_progress !== 0 ||
        slot.applied_max_instances < slot.desired_max_instances
      ) {
        return { kind: "wait" };
      }
      return {
        kind: "provision",
        jobId,
        headSha: job.head_sha,
        runnerName: job.runner_name,
        target: { owner: job.github_owner, repository: job.github_repository },
        workerOrigin: job.worker_origin,
        cacheScope:
          job.cache_scope === ""
            ? undefined
            : storedCacheScope(job.cache_scope, job.cache_fallback_scope, job.cache_write_allowed),
        installationId: job.github_installation_id,
        profile: parseProfile(job.profile_json),
        slotId: slot.slot_id,
        applicationName: slot.application_name,
        requiredMaxInstances: Math.max(1, slot.reserved_count),
        capacityGeneration: slot.capacity_generation,
        requiresConfiguration: slot.configuration_state === "configuring" && slot.configuration_owner_job_id === jobId,
      };
    }
    return { kind: "cancelled" };
  }

  async configurationReady(jobId: string): Promise<SchedulerAdmission[]> {
    const job = this.job(jobId);
    if (job === undefined || job.slot_id === null) {
      return [];
    }
    this.ctx.storage.sql.exec(
      `UPDATE scheduler_slots
       SET profile_key = COALESCE(pending_profile_key, profile_key),
           vcpu = COALESCE(pending_vcpu, vcpu),
           memory_mib = COALESCE(pending_memory_mib, memory_mib),
           disk_mb = COALESCE(pending_disk_mb, disk_mb),
           configuration_state = 'ready', configuration_owner_job_id = NULL,
           pending_profile_key = NULL, pending_vcpu = NULL, pending_memory_mib = NULL, pending_disk_mb = NULL,
           capacity_reclaim_pending = 0
       WHERE slot_id = ? AND configuration_owner_job_id = ?`,
      job.slot_id,
      jobId,
    );
    const admissions = this.admitNext();
    await this.scheduleWorkAlarmIfNeeded();
    return admissions;
  }

  async capacityPrepared(slotId: string, generation: number): Promise<SchedulerAdmission[]> {
    const slot = this.slot(slotId);
    const operation = this.rows<{ target_max_instances: number }>(
      "SELECT target_max_instances FROM capacity_operations WHERE slot_id = ? AND generation = ?",
      slotId,
      generation,
    )[0];
    if (slot === undefined || operation === undefined) {
      return [];
    }
    this.ctx.storage.sql.exec(
      `UPDATE scheduler_slots
       SET applied_max_instances = ?,
           capacity_update_in_progress = CASE WHEN capacity_update_generation = ? THEN 0 ELSE capacity_update_in_progress END
       WHERE slot_id = ?`,
      operation.target_max_instances,
      generation,
      slotId,
    );
    this.ctx.storage.sql.exec(
      "UPDATE capacity_operations SET state = 'applied', updated_at = ? WHERE slot_id = ? AND generation = ?",
      now(),
      slotId,
      generation,
    );
    this.ctx.storage.sql.exec(
      `UPDATE capacity_operations SET state = 'superseded', updated_at = ?
       WHERE slot_id = ? AND generation < ? AND state = 'pending'`,
      now(),
      slotId,
      generation,
    );
    const admissions = this.readyAdmissions();
    await this.scheduleWorkAlarmIfNeeded();
    return admissions;
  }

  async canStart(jobId: string): Promise<boolean> {
    const job = this.job(jobId);
    return job?.status === "provisioning";
  }

  async runnerProvisioned(jobId: string, runnerName: string, runnerId: number): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE scheduler_jobs
       SET runner_id = ?, updated_at = ?
       WHERE job_id = ? AND runner_name = ? AND status = 'provisioning'`,
      runnerId,
      now(),
      jobId,
      runnerName,
    );
    const job = this.rows<JobRow>(
      "SELECT * FROM scheduler_jobs WHERE job_id = ? AND runner_name = ? AND runner_id = ?",
      jobId,
      runnerName,
      runnerId,
    )[0];
    if (job === undefined) {
      return;
    }
    const timestamp = now();
    this.ctx.storage.sql.exec(
      `INSERT INTO scheduler_jit_runners
       (runner_name, source_job_id, github_owner, github_repository, profile_key, assigned_job_id, assignment_observed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)
       ON CONFLICT(runner_name) DO UPDATE SET
         source_job_id = excluded.source_job_id,
         github_owner = excluded.github_owner,
         github_repository = excluded.github_repository,
         profile_key = excluded.profile_key,
         assigned_job_id = NULL,
         assignment_observed = 0,
         updated_at = excluded.updated_at`,
      runnerName,
      jobId,
      job.github_owner,
      job.github_repository,
      job.profile_key,
      timestamp,
      timestamp,
    );
    this.recordEvent("jit-runner-created", {
      jobId,
      slotId: job?.slot_id ?? undefined,
      detail: { runnerId },
    });
  }

  async runnerStarted(runnerName: string): Promise<void> {
    const job = this.rows<JobRow>(
      "SELECT * FROM scheduler_jobs WHERE runner_name = ? AND status = 'provisioning'",
      runnerName,
    )[0];
    this.ctx.storage.sql.exec(
      "UPDATE scheduler_jobs SET status = 'running', updated_at = ? WHERE runner_name = ? AND status = 'provisioning'",
      now(),
      runnerName,
    );
    if (job !== undefined) {
      this.recordEvent("container-started", { jobId: job.job_id, slotId: job.slot_id ?? undefined });
    }
  }

  /**
   * A JIT runner may receive a different compatible queued job. Require
   * GitHub's authoritative `in_progress` delivery before granting cache
   * access, and bind that access to the actual assigned job and its scope.
   */
  async cacheAssignment(
    runnerName: string,
    repository: string,
  ): Promise<
    | {
        jobId: string;
        cacheScope: SchedulerCacheScope;
      }
    | undefined
  > {
    const [owner, repo, extra] = repository.split("/");
    if (owner === undefined || repo === undefined || extra !== undefined) {
      return undefined;
    }
    const runner = this.rows<JitRunnerRow>(
      `SELECT * FROM scheduler_jit_runners
       WHERE runner_name = ?
         AND lower(github_owner) = lower(?)
         AND lower(github_repository) = lower(?)
         AND assignment_observed = 1
         AND assigned_job_id IS NOT NULL`,
      runnerName,
      owner,
      repo,
    )[0];
    if (runner !== undefined && runner.assigned_job_id !== null) {
      const assignedJob = this.job(runner.assigned_job_id);
      if (
        assignedJob !== undefined &&
        assignedJob.github_owner.toLowerCase() === owner.toLowerCase() &&
        assignedJob.github_repository.toLowerCase() === repo.toLowerCase() &&
        assignedJob.profile_key === runner.profile_key &&
        assignedJob.cache_scope !== ""
      ) {
        return {
          jobId: assignedJob.job_id,
          cacheScope: storedCacheScope(
            assignedJob.cache_scope,
            assignedJob.cache_fallback_scope,
            assignedJob.cache_write_allowed,
          ),
        };
      }
    }
    const job = this.rows<JobRow>(
      `SELECT * FROM scheduler_jobs
       WHERE runner_name = ?
         AND lower(github_owner) = lower(?)
         AND lower(github_repository) = lower(?)
         AND (
           status IN ('provisioning', 'running', 'releasing')
           OR (status = 'completed' AND updated_at >= ?)
         )`,
      runnerName,
      owner,
      repo,
      now() - RUNNER_CACHE_POST_JOB_GRACE_MS,
    )[0];
    if (job === undefined || job.github_assignment_observed === 0 || job.cache_scope === "") {
      return undefined;
    }
    return {
      jobId: job.job_id,
      cacheScope: storedCacheScope(job.cache_scope, job.cache_fallback_scope, job.cache_write_allowed),
    };
  }

  /** @deprecated Use cacheAssignment, which follows a JIT runner's actual job. */
  async cacheScope(runnerName: string, repository: string, jobId: string): Promise<SchedulerCacheScope | undefined> {
    const [owner, repo, extra] = repository.split("/");
    if (owner === undefined || repo === undefined || extra !== undefined) {
      return undefined;
    }
    const job = this.rows<JobRow>(
      `SELECT * FROM scheduler_jobs
       WHERE job_id = ?
         AND runner_name = ?
         AND lower(github_owner) = lower(?)
         AND lower(github_repository) = lower(?)
         AND status IN ('provisioning', 'running', 'releasing')`,
      jobId,
      runnerName,
      owner,
      repo,
    )[0];
    if (job === undefined || job.github_assignment_observed === 0 || job.cache_scope === "") {
      return undefined;
    }
    return storedCacheScope(job.cache_scope, job.cache_fallback_scope, job.cache_write_allowed);
  }

  /**
   * A JIT configuration is not pinned to the queued job that caused its
   * creation. GitHub may give it any older compatible job in the repository.
   * Its `in_progress` delivery is therefore the authoritative runner-to-job
   * assignment. Move the active Container reservation to that actual job and
   * put the displaced job back through normal admission with a fresh JIT name.
   */
  async workflowJobStarted(input: SchedulerRunnerClaimInput): Promise<SchedulerResult> {
    this.recordJitRunnerAssignment(input);
    const runnerOwner = this.rows<JobRow>(
      `SELECT * FROM scheduler_jobs
       WHERE runner_name = ? AND status IN ('provisioning', 'running', 'releasing')`,
      input.runnerName,
    )[0];
    if (runnerOwner === undefined) {
      return { accepted: false, admissions: [] };
    }

    const actualJob = this.job(input.jobId);
    if (
      !jobMatchesRunnerClaim(runnerOwner, input) ||
      actualJob === undefined ||
      !jobMatchesRunnerClaim(actualJob, input)
    ) {
      this.recordEvent("github-job-started-with-unmatched-runner", {
        jobId: input.jobId,
        slotId: runnerOwner.slot_id ?? undefined,
        detail: {
          runnerName: input.runnerName,
          runnerOwnerJobId: runnerOwner.job_id,
          profileKey: input.profile.key,
        },
      });
      return { accepted: false, admissions: [] };
    }

    if (runnerOwner.job_id === input.jobId) {
      this.ctx.storage.sql.exec(
        "UPDATE scheduler_jobs SET github_assignment_observed = 1, updated_at = ? WHERE job_id = ?",
        now(),
        input.jobId,
      );
      this.recordEvent("github-job-started", {
        jobId: input.jobId,
        slotId: runnerOwner.slot_id ?? undefined,
        detail: { runnerName: input.runnerName, runnerId: input.runnerId ?? runnerOwner.runner_id },
      });
      return { accepted: true, admissions: [] };
    }

    if (runnerOwner.slot_id === null || actualJob.profile_key !== input.profile.key) {
      this.recordEvent("github-job-started-with-unmatched-runner", {
        jobId: input.jobId,
        slotId: runnerOwner.slot_id ?? undefined,
        detail: {
          runnerName: input.runnerName,
          runnerOwnerJobId: runnerOwner.job_id,
          profileKey: input.profile.key,
        },
      });
      return { accepted: false, admissions: [] };
    }

    const timestamp = now();
    const retryAttempt = runnerOwner.runner_attempt + 1;
    const retryRunnerName = `${runnerOwner.runner_name.replace(/-r\d+$/u, "")}-r${retryAttempt}`;

    this.ctx.storage.sql.exec(
      `UPDATE scheduler_jobs
       SET status = 'queued', runner_name = ?, runner_attempt = ?, slot_id = NULL, runner_id = NULL,
           failure_reason = ?, container_stopped_at = NULL, container_exit_code = NULL,
           container_stop_reason = NULL, recovery_due_at = NULL, runner_cleanup_state = 'none',
           runner_cleanup_due_at = NULL, github_assignment_observed = 0, updated_at = ?
       WHERE job_id = ?`,
      retryRunnerName,
      retryAttempt,
      `JIT runner ${input.runnerName} was assigned to GitHub job ${input.jobId}; retrying with a fresh runner`,
      timestamp,
      runnerOwner.job_id,
    );
    this.ctx.storage.sql.exec(
      `UPDATE scheduler_jobs
       SET status = 'running', runner_name = ?, slot_id = ?, runner_id = ?, failure_reason = NULL,
           container_stopped_at = NULL, container_exit_code = NULL, container_stop_reason = NULL,
           recovery_due_at = NULL, runner_cleanup_state = 'none', runner_cleanup_due_at = NULL,
           github_assignment_observed = 1, updated_at = ?
       WHERE job_id = ?`,
      input.runnerName,
      runnerOwner.slot_id,
      input.runnerId ?? runnerOwner.runner_id,
      timestamp,
      actualJob.job_id,
    );
    this.recordEvent("jit-runner-reassigned", {
      jobId: actualJob.job_id,
      slotId: runnerOwner.slot_id,
      detail: {
        runnerName: input.runnerName,
        runnerId: input.runnerId ?? runnerOwner.runner_id,
        fromJobId: runnerOwner.job_id,
      },
    });
    this.recordEvent("github-job-requeued-after-jit-mismatch", {
      jobId: runnerOwner.job_id,
      detail: { runnerName: retryRunnerName, assignedJobId: actualJob.job_id, retryAttempt },
    });

    const admissions = this.admitNext();
    await this.scheduleWorkAlarmIfNeeded();
    return { accepted: true, admissions };
  }

  private recordJitRunnerAssignment(input: SchedulerRunnerClaimInput): void {
    const runner = this.rows<JitRunnerRow>(
      "SELECT * FROM scheduler_jit_runners WHERE runner_name = ?",
      input.runnerName,
    )[0];
    const assignedJob = this.job(input.jobId);
    if (
      runner === undefined ||
      assignedJob === undefined ||
      runner.github_owner.toLowerCase() !== input.target.owner.toLowerCase() ||
      runner.github_repository.toLowerCase() !== input.target.repository.toLowerCase() ||
      runner.profile_key !== input.profile.key ||
      !jobMatchesRunnerClaim(assignedJob, input)
    ) {
      return;
    }
    this.ctx.storage.sql.exec(
      `UPDATE scheduler_jit_runners
       SET assigned_job_id = ?, assignment_observed = 1, updated_at = ?
       WHERE runner_name = ?`,
      input.jobId,
      now(),
      input.runnerName,
    );
  }

  private releaseJob(job: JobRow, status: "completed" | "cancelled" | "failed", reason?: string): void {
    if (job.slot_id === null) {
      this.ctx.storage.sql.exec(
        `UPDATE scheduler_jobs
         SET status = ?, updated_at = ?, failure_reason = ?, recovery_due_at = NULL
         WHERE job_id = ?`,
        status,
        now(),
        reason ?? null,
        job.job_id,
      );
      return;
    }
    const slot = this.slot(job.slot_id);
    if (slot === undefined) {
      return;
    }
    const reservedCount = Math.max(0, slot.reserved_count - 1);
    const targetMaxInstances = Math.max(slot.applied_max_instances, reservedCount);
    const timestamp = now();
    this.ctx.storage.sql.exec(
      `UPDATE scheduler_slots SET reserved_count = ?, desired_max_instances = ?, last_released_at = ?,
       configuration_state = CASE WHEN ? = 0 AND configuration_state = 'configuring' THEN 'idle' ELSE configuration_state END,
       configuration_owner_job_id = CASE WHEN ? = 0 AND configuration_state = 'configuring' THEN NULL ELSE configuration_owner_job_id END
       WHERE slot_id = ?`,
      reservedCount,
      targetMaxInstances,
      timestamp,
      reservedCount,
      reservedCount,
      slot.slot_id,
    );
    this.ctx.storage.sql.exec(
      `UPDATE scheduler_jobs
       SET status = ?, updated_at = ?, failure_reason = ?, recovery_due_at = NULL
       WHERE job_id = ?`,
      status,
      timestamp,
      reason ?? null,
      job.job_id,
    );
    this.recordEvent("scheduler-released", {
      jobId: job.job_id,
      slotId: slot.slot_id,
      detail: { status, reservedCount, retainedMaxInstances: targetMaxInstances },
    });
  }

  async provisioningFailed(jobId: string, reason: string): Promise<SchedulerResult> {
    const job = this.job(jobId);
    if (job === undefined || !activeJobStates.has(job.status)) {
      return { accepted: false, admissions: [] };
    }
    this.releaseJob(job, "failed", reason);
    const admissions = this.admitNext();
    await this.scheduleWorkAlarmIfNeeded();
    return { accepted: false, admissions };
  }

  async workflowJobCompleted(jobId: string): Promise<SchedulerResult> {
    const job = this.job(jobId);
    if (job === undefined) {
      return { accepted: false, admissions: [] };
    }
    if (job.status === "queued" || job.status === "admitted") {
      this.releaseJob(job, "cancelled", "GitHub completed before the runner started");
      this.recordEvent("github-job-completed-before-start", { jobId, slotId: job.slot_id ?? undefined });
      const admissions = this.admitNext();
      await this.scheduleWorkAlarmIfNeeded();
      return { accepted: true, admissions };
    }
    if (job.status === "stopped-awaiting-completion") {
      this.releaseJob(job, "completed");
      this.recordEvent("github-job-completed-after-container-stop", { jobId, slotId: job.slot_id ?? undefined });
      const admissions = this.admitNext();
      await this.scheduleWorkAlarmIfNeeded();
      return { accepted: true, admissions };
    }
    if (job.status === "provisioning" || job.status === "running") {
      const timestamp = now();
      this.ctx.storage.sql.exec(
        `UPDATE scheduler_jobs
         SET status = 'releasing', recovery_due_at = ?, updated_at = ?
         WHERE job_id = ?`,
        timestamp + RUNNER_COMPLETION_GRACE_MS,
        timestamp,
        jobId,
      );
      this.recordEvent("github-job-completed", { jobId, slotId: job.slot_id ?? undefined });
      await this.scheduleWorkAlarmIfNeeded();
    }
    return { accepted: true, admissions: [] };
  }

  async runnerStopped(runnerName: string, stop: { exitCode: number; reason: string }): Promise<SchedulerResult> {
    const job = this.rows<JobRow>("SELECT * FROM scheduler_jobs WHERE runner_name = ?", runnerName)[0];
    if (job === undefined || !activeJobStates.has(job.status)) {
      return { accepted: false, admissions: [] };
    }
    const timestamp = now();
    this.ctx.storage.sql.exec(
      `UPDATE scheduler_jobs
       SET container_stopped_at = ?, container_exit_code = ?, container_stop_reason = ?, updated_at = ?
       WHERE job_id = ?`,
      timestamp,
      stop.exitCode,
      stop.reason,
      timestamp,
      job.job_id,
    );
    this.recordEvent("container-stopped", {
      jobId: job.job_id,
      slotId: job.slot_id ?? undefined,
      detail: stop,
    });
    if (job.status === "releasing") {
      this.releaseJob(job, "completed");
      const admissions = this.admitNext();
      await this.scheduleWorkAlarmIfNeeded();
      return { accepted: true, admissions };
    }

    this.ctx.storage.sql.exec(
      `UPDATE scheduler_jobs
       SET status = 'stopped-awaiting-completion', recovery_due_at = ?, updated_at = ?
       WHERE job_id = ?`,
      timestamp + RUNNER_COMPLETION_GRACE_MS,
      timestamp,
      job.job_id,
    );
    this.recordEvent("container-stop-awaiting-github-completion", {
      jobId: job.job_id,
      slotId: job.slot_id ?? undefined,
      detail: { recoveryDueAt: timestamp + RUNNER_COMPLETION_GRACE_MS },
    });
    await this.scheduleWorkAlarmIfNeeded();
    return { accepted: true, admissions: [] };
  }

  private async retryRunnerCleanup(job: JobRow): Promise<void> {
    const timestamp = now();
    if (job.runner_id === null) {
      this.ctx.storage.sql.exec(
        `UPDATE scheduler_jobs
         SET runner_cleanup_state = 'done', runner_cleanup_due_at = NULL
         WHERE job_id = ?`,
        job.job_id,
      );
      this.recordEvent("jit-runner-cleanup-skipped", { jobId: job.job_id, slotId: job.slot_id ?? undefined });
      return;
    }

    try {
      const target = { owner: job.github_owner, repository: job.github_repository };
      const token = await githubTokenForRunner(this.env, target, job.github_installation_id, (legacyTarget) =>
        githubRunnerTokenFor(this.env, legacyTarget),
      );
      if (token === undefined) {
        throw new Error(`No GitHub App installation token is available for ${target.owner}`);
      }
      const result = await deleteGitHubRunner({ ...target, token }, job.runner_id);
      if (result.kind === "deleted" || result.kind === "not-found") {
        this.ctx.storage.sql.exec(
          `UPDATE scheduler_jobs
           SET runner_cleanup_state = 'done', runner_cleanup_due_at = NULL,
               runner_cleanup_attempts = runner_cleanup_attempts + 1
           WHERE job_id = ?`,
          job.job_id,
        );
        this.recordEvent("jit-runner-cleanup-complete", {
          jobId: job.job_id,
          slotId: job.slot_id ?? undefined,
          detail: { runnerId: job.runner_id, result: result.kind },
        });
        return;
      }

      this.ctx.storage.sql.exec(
        `UPDATE scheduler_jobs
         SET runner_cleanup_state = 'retry', runner_cleanup_due_at = ?,
             runner_cleanup_attempts = runner_cleanup_attempts + 1
         WHERE job_id = ?`,
        timestamp + RUNNER_CLEANUP_RETRY_MS,
        job.job_id,
      );
      this.recordEvent("jit-runner-cleanup-retry", {
        jobId: job.job_id,
        slotId: job.slot_id ?? undefined,
        detail: { runnerId: job.runner_id, result: result.kind, retryAt: timestamp + RUNNER_CLEANUP_RETRY_MS },
      });
    } catch (error) {
      this.ctx.storage.sql.exec(
        `UPDATE scheduler_jobs
         SET runner_cleanup_state = 'retry', runner_cleanup_due_at = ?,
             runner_cleanup_attempts = runner_cleanup_attempts + 1
         WHERE job_id = ?`,
        timestamp + RUNNER_CLEANUP_RETRY_MS,
        job.job_id,
      );
      this.recordEvent("jit-runner-cleanup-retry", {
        jobId: job.job_id,
        slotId: job.slot_id ?? undefined,
        detail: {
          runnerId: job.runner_id,
          error: error instanceof Error ? error.message : String(error),
          retryAt: timestamp + RUNNER_CLEANUP_RETRY_MS,
        },
      });
    }
  }

  private async recoverStoppedRunners(): Promise<SchedulerAdmission[]> {
    const timestamp = now();
    const stoppedJobs = this.rows<JobRow>(
      `SELECT * FROM scheduler_jobs
       WHERE status IN ('stopped-awaiting-completion', 'releasing')
         AND recovery_due_at IS NOT NULL
         AND recovery_due_at <= ?
       ORDER BY recovery_due_at ASC, job_id ASC`,
      timestamp,
    );
    const admissions: SchedulerAdmission[] = [];
    for (const job of stoppedJobs) {
      const awaitingContainerStop = job.status === "releasing";
      this.recordEvent(
        awaitingContainerStop ? "container-stop-missing-recovery-started" : "container-stop-recovery-started",
        {
          jobId: job.job_id,
          slotId: job.slot_id ?? undefined,
          detail: { runnerId: job.runner_id, stoppedAt: job.container_stopped_at },
        },
      );
      // eslint-disable-next-line no-await-in-loop -- each deletion is an account-scoped recovery action.
      await this.retryRunnerCleanup(job);
      this.releaseJob(
        job,
        awaitingContainerStop ? "completed" : "failed",
        awaitingContainerStop ? undefined : "Container stopped before GitHub reported the job complete",
      );
      admissions.push(...this.admitNext());
    }

    const cleanupRetries = this.rows<JobRow>(
      `SELECT * FROM scheduler_jobs
       WHERE runner_cleanup_state = 'retry'
         AND runner_cleanup_due_at IS NOT NULL
         AND runner_cleanup_due_at <= ?
       ORDER BY runner_cleanup_due_at ASC, job_id ASC`,
      timestamp,
    );
    for (const job of cleanupRetries) {
      // eslint-disable-next-line no-await-in-loop -- each deletion is an account-scoped recovery action.
      await this.retryRunnerCleanup(job);
    }
    return admissions;
  }

  /**
   * A Worker deployment can interrupt a Container's onStop callback after
   * GitHub has completed the job. Persist a deadline so that the account-level
   * reservation cannot be stranded if that callback never reaches this DO.
   */
  private scheduleReleaseRecoveries(): void {
    this.ctx.storage.sql.exec(
      `UPDATE scheduler_jobs
       SET recovery_due_at = ?
       WHERE status = 'releasing' AND recovery_due_at IS NULL`,
      now() + RUNNER_COMPLETION_GRACE_MS,
    );
  }

  /**
   * GitHub's completed event is authoritative: the JIT runner can no longer
   * receive work. If a Worker deployment interrupted its later onStop callback,
   * free the scheduler reservation before admitting the first post-deploy job.
   */
  private releaseCompletedJobsAwaitingContainerStop(): void {
    const releasingJobs = this.rows<JobRow>("SELECT * FROM scheduler_jobs WHERE status = 'releasing'");
    for (const job of releasingJobs) {
      this.releaseJob(job, "completed");
      this.recordEvent("container-stop-missing-recovered", {
        jobId: job.job_id,
        slotId: job.slot_id ?? undefined,
        detail: { runnerId: job.runner_id, stoppedAt: job.container_stopped_at },
      });
    }
  }

  /** Rebuild the denormalized slot count from durable job state after a restart. */
  private reconcileSlotReservations(): void {
    const slots = this.rows<SlotRow>("SELECT * FROM scheduler_slots");
    for (const slot of slots) {
      const activeCount =
        this.rows<{ count: number }>(
          `SELECT COUNT(*) AS count
         FROM scheduler_jobs
         WHERE slot_id = ? AND status IN (${activeStatusList()})`,
          slot.slot_id,
          ...ACTIVE_JOB_STATES,
        )[0]?.count ?? 0;
      if (activeCount === slot.reserved_count) {
        continue;
      }
      this.ctx.storage.sql.exec(
        "UPDATE scheduler_slots SET reserved_count = ? WHERE slot_id = ?",
        activeCount,
        slot.slot_id,
      );
      this.recordEvent("reservation-count-reconciled", {
        slotId: slot.slot_id,
        detail: { from: slot.reserved_count, to: activeCount },
      });
    }
  }

  private releaseConfigurationCapacityHolds(): void {
    const configuringSlots = this.rows<SlotRow>(
      `SELECT * FROM scheduler_slots
       WHERE configuration_state = 'configuring'
         AND capacity_reclaim_pending != 0
         AND pending_vcpu IS NOT NULL
         AND pending_memory_mib IS NOT NULL
         AND pending_disk_mb IS NOT NULL`,
    );
    const timestamp = now();
    for (const slot of configuringSlots) {
      const plan = planConfiguredCapacity(
        this.configuredCapacitySlots(),
        {
          slotId: slot.slot_id,
          resources: {
            vcpu: slot.pending_vcpu ?? 0,
            memoryMib: slot.pending_memory_mib ?? 0,
            diskMb: slot.pending_disk_mb ?? 0,
          },
          maxInstances: slot.desired_max_instances,
        },
        DEFAULT_ACCOUNT_CAPACITY,
      );
      if (plan === undefined) {
        continue;
      }
      this.scheduleCapacityReclamation(plan.reductions, timestamp);
      if (plan.reductions.length !== 0) {
        continue;
      }
      this.ctx.storage.sql.exec(
        "UPDATE scheduler_slots SET capacity_reclaim_pending = 0 WHERE slot_id = ?",
        slot.slot_id,
      );
      this.recordEvent("configuration-capacity-ready", {
        slotId: slot.slot_id,
        detail: { desiredMaxInstances: slot.desired_max_instances },
      });
    }
  }

  private recoverStalledCapacityUpdates(): void {
    const timestamp = now();
    const inProgressSlots = this.rows<SlotRow>("SELECT * FROM scheduler_slots WHERE capacity_update_in_progress != 0");
    for (const slot of inProgressSlots) {
      const operation = this.rows<{ target_max_instances: number; updated_at: number }>(
        `SELECT target_max_instances, updated_at FROM capacity_operations
         WHERE slot_id = ? AND generation = ? AND state = 'pending'`,
        slot.slot_id,
        slot.capacity_update_generation,
      )[0];
      if (operation !== undefined && timestamp - operation.updated_at < STALLED_CAPACITY_UPDATE_RECOVERY_MS) {
        continue;
      }
      this.ctx.storage.sql.exec(
        `UPDATE scheduler_slots
         SET capacity_update_in_progress = 0, capacity_debounce_until = ?
         WHERE slot_id = ? AND capacity_update_in_progress != 0 AND capacity_update_generation = ?`,
        timestamp,
        slot.slot_id,
        slot.capacity_update_generation,
      );
      const changes = this.rows<{ changes: number }>("SELECT changes() AS changes")[0]?.changes ?? 0;
      if (changes === 0) {
        continue;
      }
      this.recordEvent("capacity-update-recovered", {
        slotId: slot.slot_id,
        detail: {
          generation: slot.capacity_update_generation,
          targetMaxInstances: operation?.target_max_instances ?? slot.desired_max_instances,
        },
      });
    }
  }

  private async applyScheduledCapacityUpdates(): Promise<SchedulerAdmission[]> {
    this.recoverStalledCapacityUpdates();
    const timestamp = now();
    const dueSlots = this.rows<SlotRow>(
      `SELECT * FROM scheduler_slots
       WHERE configuration_state = 'ready'
         AND capacity_update_in_progress = 0
         AND desired_max_instances != applied_max_instances
         AND (desired_max_instances < applied_max_instances OR capacity_debounce_until <= ?)
         AND (desired_max_instances >= applied_max_instances OR reserved_count = 0)
       ORDER BY CASE WHEN desired_max_instances < applied_max_instances THEN 0 ELSE 1 END, slot_id ASC`,
      timestamp,
    );
    const admissions: SchedulerAdmission[] = [];

    for (const slot of dueSlots) {
      const targetMaxInstances = slot.desired_max_instances;
      const reducing = targetMaxInstances < slot.applied_max_instances;
      const generation = slot.capacity_generation;
      this.ctx.storage.sql.exec(
        `UPDATE scheduler_slots
         SET capacity_update_in_progress = 1, capacity_update_generation = ?
         WHERE slot_id = ? AND capacity_generation = ? AND capacity_update_in_progress = 0`,
        generation,
        slot.slot_id,
        generation,
      );
      const updated = this.rows<{ changes: number }>("SELECT changes() AS changes")[0];
      if (updated?.changes !== 1) {
        continue;
      }
      try {
        this.recordEvent(reducing ? "capacity-reclamation-started" : "capacity-upscale-started", {
          slotId: slot.slot_id,
          detail: { from: slot.applied_max_instances, to: targetMaxInstances, generation },
        });
        // eslint-disable-next-line no-await-in-loop -- one account-level DO deliberately serializes Containers API mutations.
        const prepared = await (reducing
          ? reconcileRunnerApplicationCapacity(this.env, slot.application_name, targetMaxInstances)
          : prepareRunnerApplication(this.env, slot.application_name, undefined, targetMaxInstances));
        if ("kind" in prepared && prepared.kind === "rollout") {
          this.ctx.storage.sql.exec(
            `UPDATE scheduler_slots
             SET capacity_debounce_until = CASE WHEN capacity_generation = ? THEN ? ELSE capacity_debounce_until END,
                 capacity_update_in_progress = CASE WHEN capacity_update_generation = ? THEN 0 ELSE capacity_update_in_progress END
             WHERE slot_id = ?`,
            generation,
            capacityDebounceDeadline(now()),
            generation,
            slot.slot_id,
          );
          this.recordEvent("capacity-upscale-rollout-pending", { slotId: slot.slot_id, detail: { generation } });
          continue;
        }
        // eslint-disable-next-line no-await-in-loop -- admissions are released only after the matching capacity mutation succeeds.
        admissions.push(...(await this.capacityPrepared(slot.slot_id, generation)));
        this.recordEvent(reducing ? "capacity-reclamation-applied" : "capacity-upscale-applied", {
          slotId: slot.slot_id,
          detail: { to: targetMaxInstances, generation },
        });
      } catch (error) {
        console.error("Cloudflare runner capacity change failed; retrying after debounce", {
          applicationName: slot.application_name,
          targetMaxInstances,
          error: error instanceof Error ? error.message : String(error),
        });
        this.ctx.storage.sql.exec(
          `UPDATE scheduler_slots
           SET capacity_debounce_until = CASE WHEN capacity_generation = ? THEN ? ELSE capacity_debounce_until END,
               capacity_update_in_progress = CASE WHEN capacity_update_generation = ? THEN 0 ELSE capacity_update_in_progress END
           WHERE slot_id = ?`,
          generation,
          capacityDebounceDeadline(now()),
          generation,
          slot.slot_id,
        );
      }
    }

    this.releaseConfigurationCapacityHolds();

    return admissions;
  }

  async alarm(): Promise<void> {
    const recoveredAdmissions = await this.recoverStoppedRunners();
    const capacityAdmissions = await this.applyScheduledCapacityUpdates();
    const admissions = [...recoveredAdmissions, ...capacityAdmissions, ...this.readyAdmissions(), ...this.admitNext()];
    await this.scheduleWorkAlarmIfNeeded();
    const uniqueAdmissions = new Map(admissions.map((admission) => [admission.jobId, admission]));
    for (const admission of uniqueAdmissions.values()) {
      try {
        // eslint-disable-next-line no-await-in-loop -- deterministic workflow IDs make each admission idempotent.
        await this.env.RUNNER_PROVISIONING_WORKFLOW.create({
          id: admission.workflowId,
          params: { jobId: admission.jobId },
          retention: { successRetention: "1 day", errorRetention: "7 days" },
        });
      } catch {
        // A duplicate workflow ID means the original durable workflow is already responsible for the admission.
      }
    }
  }

  async status(): Promise<SchedulerStatus> {
    const reserved = this.reservedResources();
    const configured = this.configuredResources();
    const jobs = this.rows<JobRow>("SELECT * FROM scheduler_jobs ORDER BY created_at DESC LIMIT 100").map((job) => ({
      jobId: job.job_id,
      runnerName: job.runner_name,
      repository: `${job.github_owner}/${job.github_repository}`,
      profileKey: job.profile_key,
      status: job.status,
      slotId: job.slot_id,
      queueWaitMs: job.status === "queued" ? Math.max(0, now() - job.created_at) : null,
      runnerId: job.runner_id,
      containerStoppedAt: job.container_stopped_at,
      containerExitCode: job.container_exit_code,
      containerStopReason: job.container_stop_reason,
      recoveryDueAt: job.recovery_due_at,
      runnerCleanupState: job.runner_cleanup_state,
    }));
    const slots = this.rows<SlotRow>("SELECT * FROM scheduler_slots ORDER BY slot_id ASC").map((slot) => ({
      slotId: slot.slot_id,
      applicationName: slot.application_name,
      kind: slot.kind,
      profileKey: slot.profile_key,
      configurationState: isSlotConfigurationState(slot.configuration_state) ? slot.configuration_state : "idle",
      reservedCount: slot.reserved_count,
      desiredMaxInstances: slot.desired_max_instances,
      appliedMaxInstances: slot.applied_max_instances,
      capacityDebounceUntil: slot.capacity_debounce_until === 0 ? null : slot.capacity_debounce_until,
      capacityUpdateInProgress: slot.capacity_update_in_progress !== 0,
      pendingProfileKey: slot.pending_profile_key,
      capacityReclaimPending: slot.capacity_reclaim_pending !== 0,
      lastReleasedAt: slot.last_released_at === 0 ? null : slot.last_released_at,
    }));
    const events = this.rows<SchedulerEventRow>(
      "SELECT * FROM scheduler_events ORDER BY created_at DESC, event_id DESC LIMIT 100",
    ).map((event) => ({
      eventId: event.event_id,
      jobId: event.job_id,
      slotId: event.slot_id,
      kind: event.kind,
      detail: parseEventDetail(event.detail_json),
      createdAt: event.created_at,
    }));
    return { capacity: { limit: DEFAULT_ACCOUNT_CAPACITY, reserved, configured }, jobs, slots, events };
  }
}
