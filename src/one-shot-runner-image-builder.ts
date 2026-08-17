export interface OneShotRunnerImageBuilderContainer {
  readonly running: boolean;
  destroy(reason: string): Promise<void>;
}

/**
 * Run one disposable builder VM and tear it down even when start, exec, or
 * output collection fails. The platform can report state errors transiently
 * during a rollout, so cleanup deliberately never depends on a second state
 * read after a successful start.
 */
export async function runOneShotRunnerImageBuilder<T>(
  container: OneShotRunnerImageBuilderContainer,
  start: () => Promise<void>,
  work: () => Promise<T>,
): Promise<T> {
  let alreadyRunning: boolean;
  try {
    alreadyRunning = container.running;
  } catch (error) {
    // A Container rollout can leave a transient state record that reports an
    // active VM but cannot be attached to its Durable Object. A direct destroy
    // is still safe and prevents that orphan from consuming the builder slot.
    try {
      await container.destroy("Recovering an unreachable Cloudflare runner image builder");
    } catch (cleanupError) {
      console.error("Cloudflare image builder could not destroy an unreachable temporary Container", {
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
    throw new Error("Cloudflare image builder could not inspect its Container state", { cause: error });
  }
  if (alreadyRunning) {
    await container.destroy("Superseded by a newer Cloudflare runner image build");
  }

  let started = false;
  try {
    await start();
    started = true;
    return await work();
  } finally {
    // The builder is strictly one-shot. This runs for both a successful image
    // push and every failure/timeout path, avoiding idle billable Containers.
    if (started) {
      try {
        await container.destroy("Cloudflare runner image build completed");
      } catch (error) {
        console.error("Cloudflare image builder could not destroy its temporary Container", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
