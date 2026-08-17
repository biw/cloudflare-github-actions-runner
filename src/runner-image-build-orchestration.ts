import type { ContainerRolloutStatus, PrepareRunnerApplicationResult } from "./cloudflare-containers";

interface NamedRunnerImageBuilderNamespace<Builder> {
  getByName(name: string): Builder;
}

/**
 * Durable Object stubs become unusable after many infrastructure exceptions.
 * Resolve the named builder inside each operation so a Workflow step retry
 * never inherits the failed attempt's RPC connection.
 */
export async function withFreshRunnerImageBuilder<Builder, Result>(
  namespace: NamedRunnerImageBuilderNamespace<Builder>,
  operation: (builder: Builder) => Promise<Result>,
): Promise<Result> {
  return await operation(namespace.getByName("runner-image-builder"));
}

export async function waitForRunnerImageBuilderRollout(
  rollout: PrepareRunnerApplicationResult,
  check: (attempt: number, applicationId: string, rolloutId: string) => Promise<ContainerRolloutStatus>,
  sleep: (attempt: number) => Promise<void>,
  maximumChecks: number,
): Promise<void> {
  if (rollout.kind === "ready") {
    return;
  }
  for (let attempt = 1; attempt <= maximumChecks; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- every poll is an independently durable Workflow step.
    const status = await check(attempt, rollout.applicationId, rollout.rolloutId);
    if (status === "completed") {
      return;
    }
    if (status === "reverted" || status === "replaced") {
      throw new Error(`Cloudflare could not roll out the daemonless runner image builder (${status})`);
    }
    if (attempt < maximumChecks) {
      // eslint-disable-next-line no-await-in-loop -- release the Workflow invocation between platform status checks.
      await sleep(attempt);
    }
  }
  throw new Error("Cloudflare timed out rolling out the daemonless runner image builder");
}

export async function waitForRunnerImageBuilderApplicationIdle(
  check: (attempt: number) => Promise<boolean>,
  sleep: (attempt: number) => Promise<void>,
  maximumChecks: number,
): Promise<void> {
  for (let attempt = 1; attempt <= maximumChecks; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- every poll is an independently durable Workflow step.
    if (!(await check(attempt))) {
      return;
    }
    if (attempt < maximumChecks) {
      // eslint-disable-next-line no-await-in-loop -- release the Workflow invocation between platform status checks.
      await sleep(attempt);
    }
  }
  throw new Error("Cloudflare timed out stopping the temporary daemonless runner image builder");
}

interface FailedRunnerImageBuildCleanupBuilder {
  abortBootstrap(workflowId: string): Promise<void>;
  abortBuild(workflowId: string): Promise<void>;
  updateBuildProgress(workflowId: string, phase: "failed"): Promise<void>;
}

export async function cleanupFailedRunnerImageBuild(
  namespace: NamedRunnerImageBuilderNamespace<FailedRunnerImageBuildCleanupBuilder>,
  workflowId: string,
  ownsBuild: boolean,
): Promise<void> {
  const cleanup = async (
    operation: string,
    callback: (builder: FailedRunnerImageBuildCleanupBuilder) => Promise<void>,
  ) => {
    try {
      await withFreshRunnerImageBuilder(namespace, callback);
    } catch (error) {
      console.error("Cloudflare image builder cleanup failed", {
        operation,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  await cleanup("abort bootstrap", (builder) => builder.abortBootstrap(workflowId));
  if (ownsBuild) {
    await cleanup("abort build", (builder) => builder.abortBuild(workflowId));
  }
  await cleanup("record failed progress", (builder) => builder.updateBuildProgress(workflowId, "failed"));
}

export const runnerImageBuildTerminalErrorName = "RunnerImageBuildTerminalError";

/** Infrastructure interruptions are replayable and must retain their leases. */
export function runnerImageBuildFailureRequiresCleanup(cause: unknown): boolean {
  return cause instanceof Error && cause.name === runnerImageBuildTerminalErrorName;
}
