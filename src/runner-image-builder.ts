import { Container } from "@cloudflare/containers";

import { runnerApplicationImageRolloutsAreActive } from "./cloudflare-containers";
import { bootstrapRunnerImageBuilder } from "./runner-image-builder-bootstrap";
import type { WorkerEnvironment } from "./environment";
import { githubRepositoryArchiveWithMetadata } from "./github-app";
import {
  runnerImageBuilderBuiltPath,
  runnerImageBuilderBusyboxPath,
  runnerImageBuilderCommand,
  runnerImageBuilderEntrypoint,
  runnerImageBuilderExitCode,
  runnerImageBuilderExitError,
  runnerImageBuilderExitStatusPath,
  runnerImageBuilderLogPath,
  runnerImageBuilderResultPath,
} from "./runner-image-builder-command";
import {
  runnerImageBuilderBootstrapReference,
  runnerImageRepository,
  runnerImageSourceArchiveKey,
  type RunnerImageSource,
} from "./runner-image";

export interface RunnerImageBuildResult {
  sourceDigest: string;
  imageReference: string;
  built: boolean;
}

export type RunnerImageBuildStatus =
  | { kind: "running" }
  | { kind: "completed"; result: RunnerImageBuildResult }
  | { kind: "failed"; exitCode: number; diagnostic?: string };

export interface RunnerImageBuildStart {
  /** True only for the Workflow that acquired this shared build slot. */
  owner: boolean;
}

export interface RunnerImageRolloutLease {
  acquired: boolean;
  /**
   * True only if an earlier Workflow attempt may have stopped while its
   * external rollout calls were in flight. A normal retry after busy runners
   * must not repeat completed rollouts for the already-idle applications.
   */
  reissueMatchingImageRollouts: boolean;
}

export const runnerImageBuildPhases = [
  "queued",
  "bootstrapping-builder",
  "rolling-out-builder",
  "downloading-source",
  "starting-builder",
  "preparing-build-context",
  "checking-image-cache",
  "building-and-pushing",
  "rolling-out",
  "complete",
  "failed",
] as const;

export type RunnerImageBuildPhase = (typeof runnerImageBuildPhases)[number];

export interface RunnerImageBuildProgress {
  workflowId: string;
  phase: RunnerImageBuildPhase;
  updatedAt: string;
}

interface ActiveRunnerImageBuild {
  workflowId: string;
  sourceArchiveKey: string;
  state: "active";
  leaseExpiresAt: number;
  /** Result persisted before destructive Container cleanup is attempted. */
  terminal?: CompleteRunnerImageBuild | FailedRunnerImageBuild;
}

interface CompleteRunnerImageBuild {
  workflowId: string;
  sourceArchiveKey: string;
  state: "complete";
  result: RunnerImageBuildResult;
}

interface FailedRunnerImageBuild {
  workflowId: string;
  sourceArchiveKey: string;
  state: "failed";
  exitCode: number;
  diagnostic?: string;
}

interface RollingOutRunnerImageBuild {
  workflowId: string;
  sourceArchiveKey: string;
  state: "rolling-out";
  result: RunnerImageBuildResult;
  leaseExpiresAt: number;
  /** Cleared only after a complete, non-throwing application-rollout pass. */
  rolloutAttemptInFlight: boolean;
}

interface ReadyBootstrapImageState {
  state: "ready";
  reference: string;
  deploymentId: string;
}

interface BootstrappingImageState {
  state: "bootstrapping";
  reference: string;
  deploymentId: string;
  workflowId: string;
  leaseExpiresAt: number;
}

type BootstrapImageState = ReadyBootstrapImageState | BootstrappingImageState;

type RunnerImageBuildState =
  | ActiveRunnerImageBuild
  | CompleteRunnerImageBuild
  | FailedRunnerImageBuild
  | RollingOutRunnerImageBuild;

const runnerImageBuildProgressKey = "runner-image-build-progress";
const bootstrapImageKey = "runner-image-builder-bootstrap-image";
/** Increment when the per-build environment contract changes. */
export const runnerImageBuilderProtocolVersion = "kaniko-v2";
const sourceDigestPattern = /^[a-f0-9]{24}$/u;
const runnerImageBuilderDiagnosticLimit = 4_000;
const runnerImageBuildStateKey = "runner-image-build-state";
const runnerImageRolloutLeaseMilliseconds = 5 * 60 * 1_000;
const runnerImageBootstrapLeaseMilliseconds = 60 * 60 * 1_000;
// Staging can consume the 30-minute build step before the 29-minute detached
// status window begins. Leave recovery headroom beyond their combined bound.
const runnerImageBuildLeaseMilliseconds = 70 * 60 * 1_000;
const runnerImageSourceHost = "runner-image-source.internal";
const runnerImageSourceUrl = `http://${runnerImageSourceHost}/source.tar.gz`;

function runnerImageBuilderDiagnostic(stderr: ArrayBuffer): string | undefined {
  const diagnostic = new TextDecoder().decode(stderr).trim();
  return diagnostic === "" ? undefined : diagnostic.slice(-runnerImageBuilderDiagnosticLimit);
}

function runnerImageBuildResult(value: string): RunnerImageBuildResult | undefined {
  const [sourceDigest, imageReference, ...extra] = value.trim().split(/\s+/u);
  if (
    sourceDigest === undefined ||
    imageReference === undefined ||
    extra.length > 0 ||
    !sourceDigestPattern.test(sourceDigest) ||
    !/^registry\.cloudflare\.com\/[a-z0-9][a-z0-9._/-]*:runner-[a-f0-9]{24}$/u.test(imageReference)
  ) {
    return undefined;
  }
  return { sourceDigest, imageReference, built: true };
}

function runnerImageRegistryManifestUrl(repository: string): string {
  return `http://registry.cloudflare.com/v2/${repository.slice("registry.cloudflare.com/".length)}/manifests`;
}

/** One shared daemonless batch process, coalesced across concurrent Workflows. */
export class RunnerImageBuilder extends Container<WorkerEnvironment> {
  enableInternet = true;
  interceptHttps = true;
  // Detached image builds can legitimately run for 29 minutes. Durable Object
  // RPC calls do not renew the Containers SDK activity timer, so the default
  // 10-minute timeout would send SIGTERM to an otherwise healthy Kaniko build.
  sleepAfter = "2h";
  static outboundByHost = {
    "registry.cloudflare.com": (request: Request) => fetch(request),
  };

  override onStart(): void {
    console.log("Cloudflare runner-image builder Container started");
  }

  override onStop({ exitCode, reason }: { exitCode: number; reason: string }): void {
    console.log("Cloudflare runner-image builder Container stopped", { exitCode, reason });
  }

  override onError(cause: unknown): never {
    console.error("Cloudflare runner-image builder Container failed", {
      error: cause instanceof Error ? cause.message : String(cause),
    });
    throw cause;
  }

  async protocolVersion(): Promise<string> {
    return runnerImageBuilderProtocolVersion;
  }

  async updateBuildProgress(workflowId: string, phase: RunnerImageBuildPhase): Promise<void> {
    await this.ctx.storage.put(runnerImageBuildProgressKey, { workflowId, phase, updatedAt: new Date().toISOString() });
  }

  async buildProgress(workflowId: string): Promise<RunnerImageBuildProgress | undefined> {
    const progress = await this.ctx.storage.get<RunnerImageBuildProgress>(runnerImageBuildProgressKey);
    return progress?.workflowId === workflowId ? progress : undefined;
  }

  private bootstrapReference(): string {
    const reference = runnerImageBuilderBootstrapReference(this.env);
    if (reference === undefined) {
      throw new Error("Cloudflare image builder has an invalid private builder-image configuration");
    }
    return reference;
  }

  private bootstrapDeploymentId(): string | undefined {
    const deploymentId: string = this.env.RUNNER_IMAGE_BUILDER_BOOTSTRAP_DEPLOYMENT_ID;
    return deploymentId === "" ? undefined : deploymentId;
  }

  async bootstrapImageReady(): Promise<boolean> {
    const reference = this.bootstrapReference();
    const deploymentId = this.bootstrapDeploymentId();
    if (deploymentId === undefined) {
      return false;
    }
    const state = await this.ctx.storage.get<BootstrapImageState>(bootstrapImageKey);
    return state?.state === "ready" && state.reference === reference && state.deploymentId === deploymentId;
  }

  /** Claim the deployment-scoped bootstrap so concurrent Workflows join it. */
  async beginBootstrap(workflowId: string): Promise<boolean> {
    const reference = this.bootstrapReference();
    const deploymentId = this.bootstrapDeploymentId();
    if (deploymentId === undefined) {
      throw new Error("Cloudflare image builder bootstrap is missing its deployment identity");
    }
    const state = await this.ctx.storage.get<BootstrapImageState>(bootstrapImageKey);
    if (state?.state === "ready" && state.reference === reference && state.deploymentId === deploymentId) {
      return false;
    }
    if (
      state?.state === "bootstrapping" &&
      state.reference === reference &&
      state.deploymentId === deploymentId &&
      state.leaseExpiresAt > Date.now()
    ) {
      if (state.workflowId !== workflowId) {
        return false;
      }
      await this.ctx.storage.put(bootstrapImageKey, {
        ...state,
        leaseExpiresAt: Date.now() + runnerImageBootstrapLeaseMilliseconds,
      } satisfies BootstrappingImageState);
      return true;
    }
    await this.ctx.storage.put(bootstrapImageKey, {
      state: "bootstrapping",
      reference,
      deploymentId,
      workflowId,
      leaseExpiresAt: Date.now() + runnerImageBootstrapLeaseMilliseconds,
    } satisfies BootstrappingImageState);
    return true;
  }

  async bootstrap(): Promise<string> {
    return (await bootstrapRunnerImageBuilder(this.env)).reference;
  }

  async stopForBootstrapRollout(): Promise<void> {
    const container = this.ctx.container;
    if (container === undefined) {
      throw new Error("Cloudflare image builder has no Container runtime");
    }
    if (container.running) {
      await container.destroy("Preparing the private daemonless builder image rollout");
    }
  }

  async markBootstrapImageReady(reference: string, workflowId: string): Promise<void> {
    if (reference !== this.bootstrapReference()) {
      throw new Error("Cloudflare image builder bootstrap returned an unexpected image reference");
    }
    const deploymentId = this.bootstrapDeploymentId();
    if (deploymentId === undefined) {
      throw new Error("Cloudflare image builder bootstrap is missing its deployment identity");
    }
    const state = await this.ctx.storage.get<BootstrapImageState>(bootstrapImageKey);
    if (
      state?.state !== "bootstrapping" ||
      state.reference !== reference ||
      state.deploymentId !== deploymentId ||
      state.workflowId !== workflowId
    ) {
      throw new Error("Cloudflare image builder bootstrap lost its deployment-scoped claim");
    }
    await this.ctx.storage.put(bootstrapImageKey, {
      state: "ready",
      reference,
      deploymentId,
    } satisfies ReadyBootstrapImageState);
  }

  async abortBootstrap(workflowId: string): Promise<void> {
    const state = await this.ctx.storage.get<BootstrapImageState>(bootstrapImageKey);
    if (state?.state === "bootstrapping" && state.workflowId === workflowId) {
      await this.ctx.storage.delete(bootstrapImageKey);
    }
  }

  /** Renew the bootstrap lease before a bounded external operation. */
  async renewBootstrap(workflowId: string): Promise<void> {
    const state = await this.ctx.storage.get<BootstrapImageState>(bootstrapImageKey);
    if (state?.state !== "bootstrapping" || state.workflowId !== workflowId) {
      throw new Error("Cloudflare image builder bootstrap lost its deployment-scoped claim");
    }
    await this.ctx.storage.put(bootstrapImageKey, {
      ...state,
      leaseExpiresAt: Date.now() + runnerImageBootstrapLeaseMilliseconds,
    } satisfies BootstrappingImageState);
  }

  private async startContainer(sourceArchiveKey: string): Promise<void> {
    const container = this.ctx.container;
    if (container === undefined) {
      throw new Error("Cloudflare image builder has no Container runtime");
    }
    const registryProxy = this.ctx.exports.RunnerImageBuilderRegistryProxy({ props: {} });
    const internetProxy = this.ctx.exports.RunnerImageBuilderInternetProxy({ props: {} });
    const sourceProxy = this.ctx.exports.RunnerImageBuilderSourceProxy({ props: { sourceArchiveKey } });
    await this.start({ enableInternet: true, entrypoint: runnerImageBuilderEntrypoint() });
    await Promise.all([
      container.interceptOutboundHttp("registry.cloudflare.com", registryProxy),
      container.interceptOutboundHttp(runnerImageSourceHost, sourceProxy),
      // Kaniko cannot use the injected Container CA for Docker Hub. Each
      // loopback proxy immediately upgrades this hop to verified HTTPS.
      container.interceptOutboundHttp("auth.docker.io", internetProxy),
      container.interceptOutboundHttp("index.docker.io", internetProxy),
      container.interceptOutboundHttp("registry-1.docker.io", internetProxy),
    ]);
  }

  private async releaseBuild(
    workflowId: string,
    sourceArchiveKey: string,
    destroyContainer: boolean,
  ): Promise<boolean> {
    const current = await this.ctx.storage.get<RunnerImageBuildState>(runnerImageBuildStateKey);
    if (current?.workflowId !== workflowId || current.state !== "active") {
      return true;
    }
    try {
      if (destroyContainer && this.ctx.container !== undefined) {
        await this.ctx.container.destroy();
      }
    } catch (error) {
      console.error("Cloudflare image builder could not destroy its failed temporary Container", {
        error: error instanceof Error ? error.message : String(error),
      });
      // Leave the active slot and archive in place. Starting another build
      // before Cloudflare confirms this process is gone risks both processes
      // reading and writing the same workspace paths.
      return false;
    }
    await Promise.all([
      this.ctx.storage.delete(runnerImageBuildStateKey),
      this.env.RUNNER_IMAGE_SOURCE.delete(sourceArchiveKey),
    ]);
    return true;
  }

  async startBuild(workflowId: string, source: RunnerImageSource): Promise<RunnerImageBuildStart> {
    const container = this.ctx.container;
    if (container === undefined) {
      throw new Error("Cloudflare image builder has no Container runtime");
    }
    const sourceArchiveKey = runnerImageSourceArchiveKey(workflowId);
    const repository = runnerImageRepository(this.env);
    if (sourceArchiveKey === undefined || repository === undefined) {
      throw new Error("Cloudflare image builder has an invalid source or registry configuration");
    }

    let existing = await this.ctx.storage.get<RunnerImageBuildState>(runnerImageBuildStateKey);
    if (existing?.state === "active") {
      if (existing.leaseExpiresAt > Date.now()) {
        return { owner: existing.workflowId === workflowId };
      }
      const released = await this.releaseBuild(existing.workflowId, existing.sourceArchiveKey, true);
      if (!released) {
        return { owner: false };
      }
    }
    if (existing?.state === "rolling-out") {
      if (existing.leaseExpiresAt > Date.now()) {
        return { owner: existing.workflowId === workflowId };
      }
      existing = await this.reconcileExpiredRollOut(existing);
      if (existing.state === "rolling-out") {
        return { owner: false };
      }
    }
    try {
      // A completed build records its result even if Cloudflare's first
      // destroy request times out. Do not let that stale command host share
      // the next build's fixed workspace paths.
      if (container.running) {
        await container.destroy("Superseded by a newer Cloudflare runner image build");
      }
    } catch (error) {
      throw new Error("Cloudflare image builder could not clear its previous temporary Container", { cause: error });
    }
    await this.ctx.storage.put(runnerImageBuildStateKey, {
      workflowId,
      sourceArchiveKey,
      state: "active",
      leaseExpiresAt: Date.now() + runnerImageBuildLeaseMilliseconds,
    });

    try {
      const archive = await githubRepositoryArchiveWithMetadata(this.env, source.repository, source.ref);
      if (archive === undefined) {
        throw new Error("Cloudflare image builder could not download the configured source archive");
      }
      await this.env.RUNNER_IMAGE_SOURCE.put(sourceArchiveKey, archive.body, {
        httpMetadata: { contentType: "application/gzip" },
      });
      await this.updateBuildProgress(workflowId, "starting-builder");
      try {
        await this.startContainer(sourceArchiveKey);
      } catch (error) {
        console.error("Cloudflare image builder could not install its proxies or start", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw new Error("Cloudflare image builder could not start its daemonless command host", { cause: error });
      }
      const command = await container.exec(["/busybox/sh", "-c", runnerImageBuilderCommand()], {
        env: {
          RUNNER_IMAGE_SOURCE_URL: runnerImageSourceUrl,
          RUNNER_IMAGE_REPOSITORY: repository,
          RUNNER_IMAGE_REGISTRY_MANIFEST_URL: runnerImageRegistryManifestUrl(repository),
          RUNNER_IMAGE_BUILD_DETACHED: "1",
        },
        stdout: "ignore",
        stderr: "pipe",
      });
      const output = await command.output();
      if (output.exitCode !== 0) {
        const diagnostic = runnerImageBuilderDiagnostic(output.stderr);
        if (diagnostic !== undefined) {
          console.error("Cloudflare runner-image builder diagnostic:", diagnostic);
        }
        throw new Error(runnerImageBuilderExitError(runnerImageBuilderExitCode(output.exitCode)));
      }
      await this.updateBuildProgress(workflowId, "building-and-pushing");
      return { owner: true };
    } catch (error) {
      const released = await this.releaseBuild(workflowId, sourceArchiveKey, true);
      if (!released) {
        // Preserve a retryable terminal record for the next status poll. It
        // will keep the slot exclusive until destroy succeeds, rather than
        // leaving joiners to poll a command that never started.
        const current = await this.ctx.storage.get<RunnerImageBuildState>(runnerImageBuildStateKey);
        if (current?.state === "active" && current.workflowId === workflowId) {
          await this.ctx.storage.put(runnerImageBuildStateKey, {
            ...current,
            terminal: {
              workflowId,
              sourceArchiveKey,
              state: "failed",
              exitCode: 1,
              diagnostic: "Cloudflare image builder could not stop its temporary Container after startup failed",
            },
          });
        }
      }
      await this.updateBuildProgress(workflowId, "failed");
      throw error;
    }
  }

  /**
   * A Workflow may stop after submitting rollout requests but before releasing
   * its lease. Query Cloudflare before un-fencing the next source build; when
   * the platform still reports any runner image rollout, renew the lease and
   * let a later poll reconcile it again.
   */
  private async reconcileExpiredRollOut(state: RollingOutRunnerImageBuild): Promise<RunnerImageBuildState> {
    try {
      if (await runnerApplicationImageRolloutsAreActive(this.env)) {
        const active = { ...state, leaseExpiresAt: Date.now() + runnerImageRolloutLeaseMilliseconds };
        await this.ctx.storage.put(runnerImageBuildStateKey, active);
        return active;
      }
    } catch (error) {
      console.error("Cloudflare image builder could not reconcile an expired rollout lease", {
        error: error instanceof Error ? error.message : String(error),
      });
      const active = { ...state, leaseExpiresAt: Date.now() + runnerImageRolloutLeaseMilliseconds };
      await this.ctx.storage.put(runnerImageBuildStateKey, active);
      return active;
    }
    const completed: CompleteRunnerImageBuild = { ...state, state: "complete" };
    await this.ctx.storage.put(runnerImageBuildStateKey, completed);
    return completed;
  }

  private async buildDiagnostic(): Promise<string | undefined> {
    const container = this.ctx.container;
    if (container === undefined) {
      return undefined;
    }
    try {
      const process = await container.exec(
        [
          runnerImageBuilderBusyboxPath,
          "tail",
          "-c",
          String(runnerImageBuilderDiagnosticLimit),
          runnerImageBuilderLogPath,
        ],
        { stdout: "pipe", stderr: "ignore" },
      );
      return runnerImageBuilderDiagnostic((await process.output()).stdout);
    } catch {
      return undefined;
    }
  }

  private async completedBuildResult(): Promise<RunnerImageBuildResult | undefined> {
    const container = this.ctx.container;
    if (container === undefined) {
      return undefined;
    }
    try {
      const process = await container.exec([runnerImageBuilderBusyboxPath, "cat", runnerImageBuilderResultPath], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const result = runnerImageBuildResult(new TextDecoder().decode((await process.output()).stdout));
      if (result === undefined) {
        return undefined;
      }
      const built = new TextDecoder()
        .decode(
          (
            await (
              await container.exec([runnerImageBuilderBusyboxPath, "cat", runnerImageBuilderBuiltPath], {
                stdout: "pipe",
                stderr: "ignore",
              })
            ).output()
          ).stdout,
        )
        .trim();
      return built === "true" || built === "false" ? { ...result, built: built === "true" } : undefined;
    } catch {
      return undefined;
    }
  }

  private async finalizeTerminalBuild(
    active: ActiveRunnerImageBuild,
    terminal: CompleteRunnerImageBuild | FailedRunnerImageBuild,
  ): Promise<RunnerImageBuildStatus> {
    const container = this.ctx.container;
    if (container === undefined) {
      return { kind: "running" };
    }
    try {
      await container.destroy();
    } catch (error) {
      console.error("Cloudflare image builder could not destroy its completed temporary Container", {
        error: error instanceof Error ? error.message : String(error),
      });
      // Do not permanently fence future builds on a cleanup API failure. The
      // next build checks for and destroys this stale command host before it
      // starts one with the same fixed workspace paths.
    }
    await Promise.all([
      this.ctx.storage.put(runnerImageBuildStateKey, terminal),
      this.env.RUNNER_IMAGE_SOURCE.delete(active.sourceArchiveKey),
    ]);
    return terminal.state === "complete"
      ? { kind: "completed", result: terminal.result }
      : {
          kind: "failed",
          exitCode: terminal.exitCode,
          diagnostic: terminal.diagnostic,
        };
  }

  async buildStatus(): Promise<RunnerImageBuildStatus> {
    const state = await this.ctx.storage.get<RunnerImageBuildState>(runnerImageBuildStateKey);
    if (state === undefined) {
      return { kind: "failed", exitCode: 1 };
    }
    if (state.state === "complete") {
      return { kind: "completed", result: state.result };
    }
    if (state.state === "rolling-out") {
      if (state.leaseExpiresAt <= Date.now()) {
        const reconciled = await this.reconcileExpiredRollOut(state);
        return reconciled.state === "complete" ? { kind: "completed", result: reconciled.result } : { kind: "running" };
      }
      return { kind: "running" };
    }
    if (state.state === "failed") {
      return { kind: "failed", exitCode: state.exitCode, diagnostic: state.diagnostic };
    }

    if (state.terminal !== undefined) {
      return this.finalizeTerminalBuild(state, state.terminal);
    }

    if (state.leaseExpiresAt <= Date.now()) {
      const released = await this.releaseBuild(state.workflowId, state.sourceArchiveKey, true);
      return released ? { kind: "failed", exitCode: 1 } : { kind: "running" };
    }

    const container = this.ctx.container;
    if (container === undefined) {
      return { kind: "failed", exitCode: 1 };
    }
    let exitCode: number;
    try {
      const process = await container.exec(
        [
          runnerImageBuilderBusyboxPath,
          "sh",
          "-c",
          `if [ -f "${runnerImageBuilderExitStatusPath}" ]; then read exit_code < "${runnerImageBuilderExitStatusPath}"; printf "%s" "$exit_code"; else printf running; fi`,
        ],
        { stdout: "pipe", stderr: "ignore" },
      );
      const status = new TextDecoder().decode((await process.output()).stdout).trim();
      if (status === "running") {
        return { kind: "running" };
      }
      exitCode = runnerImageBuilderExitCode(Number(status));
    } catch (error) {
      console.error("Cloudflare image builder could not poll its detached build", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { kind: "running" };
    }

    const result = exitCode === 0 ? await this.completedBuildResult() : undefined;
    const diagnostic = exitCode === 0 ? undefined : await this.buildDiagnostic();
    const terminal: CompleteRunnerImageBuild | FailedRunnerImageBuild =
      result === undefined
        ? {
            ...state,
            state: "failed",
            exitCode: exitCode === 0 ? 1 : exitCode,
            diagnostic,
          }
        : { ...state, state: "complete", result };
    // Persist the result before destroying its Container. If cleanup suffers
    // a transient failure, a later poll can resume safely without trying to
    // read result files that no longer exist.
    const cleanupPending: ActiveRunnerImageBuild = { ...state, terminal };
    await this.ctx.storage.put(runnerImageBuildStateKey, cleanupPending);
    return this.finalizeTerminalBuild(cleanupPending, terminal);
  }

  /** Acquire a Durable Object lease spanning an external application rollout. */
  async beginRollOut(workflowId: string, imageReference: string): Promise<RunnerImageRolloutLease> {
    const state = await this.ctx.storage.get<RunnerImageBuildState>(runnerImageBuildStateKey);
    if (
      state?.state === "rolling-out" &&
      state.workflowId === workflowId &&
      state.result.imageReference === imageReference
    ) {
      await this.ctx.storage.put(runnerImageBuildStateKey, {
        ...state,
        leaseExpiresAt: Date.now() + runnerImageRolloutLeaseMilliseconds,
        rolloutAttemptInFlight: true,
      });
      // Older Durable Object records predate this field. Treat them as
      // ambiguous once, then a successful pass writes an explicit false.
      return { acquired: true, reissueMatchingImageRollouts: state.rolloutAttemptInFlight !== false };
    }
    if (
      state?.state !== "complete" ||
      state.workflowId !== workflowId ||
      state.result.imageReference !== imageReference
    ) {
      return { acquired: false, reissueMatchingImageRollouts: false };
    }
    await this.ctx.storage.put(runnerImageBuildStateKey, {
      ...state,
      state: "rolling-out",
      leaseExpiresAt: Date.now() + runnerImageRolloutLeaseMilliseconds,
      rolloutAttemptInFlight: true,
    });
    return { acquired: true, reissueMatchingImageRollouts: false };
  }

  /**
   * A successful pass is no longer ambiguous, even if it deferred a busy
   * application. The next scheduled retry should touch only applications
   * that still need the image.
   */
  async completeRollOutAttempt(workflowId: string, imageReference: string): Promise<void> {
    const state = await this.ctx.storage.get<RunnerImageBuildState>(runnerImageBuildStateKey);
    if (
      state?.state === "rolling-out" &&
      state.workflowId === workflowId &&
      state.result.imageReference === imageReference
    ) {
      await this.ctx.storage.put(runnerImageBuildStateKey, { ...state, rolloutAttemptInFlight: false });
    }
  }

  async finishRollOut(workflowId: string, imageReference: string): Promise<void> {
    const state = await this.ctx.storage.get<RunnerImageBuildState>(runnerImageBuildStateKey);
    if (
      state?.state === "rolling-out" &&
      state.workflowId === workflowId &&
      state.result.imageReference === imageReference
    ) {
      await this.ctx.storage.put(runnerImageBuildStateKey, { ...state, state: "complete" });
    }
  }

  /** Only the owner of an active build can stop and clear it. */
  async abortBuild(workflowId: string): Promise<void> {
    const state = await this.ctx.storage.get<RunnerImageBuildState>(runnerImageBuildStateKey);
    if (state?.state === "rolling-out" && state.workflowId === workflowId) {
      // A failed Workflow may already have submitted rollouts for a prefix of
      // applications. Keep its lease until Cloudflare confirms those rollouts
      // settle, so a newer source cannot abandon that partial transition.
      return;
    }
    if (state?.state !== "active" || state.workflowId !== workflowId) {
      return;
    }
    const released = await this.releaseBuild(workflowId, state.sourceArchiveKey, true);
    if (!released) {
      throw new Error("Cloudflare image builder cleanup is still waiting for its temporary Container to stop");
    }
  }
}
