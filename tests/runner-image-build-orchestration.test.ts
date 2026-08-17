import { describe, expect, it, vi } from "vite-plus/test";

import type { ContainerRolloutStatus } from "../src/cloudflare-containers";
import {
  cleanupFailedRunnerImageBuild,
  runnerImageBuildFailureRequiresCleanup,
  runnerImageBuildTerminalErrorName,
  waitForRunnerImageBuilderApplicationIdle,
  waitForRunnerImageBuilderRollout,
  withFreshRunnerImageBuilder,
} from "../src/runner-image-build-orchestration";

interface ProtocolBuilder {
  protocolVersion(): Promise<string>;
}

interface CleanupBuilder {
  abortBootstrap(workflowId: string): Promise<void>;
  abortBuild(workflowId: string): Promise<void>;
  updateBuildProgress(workflowId: string, phase: "failed"): Promise<void>;
}

describe("runner-image build Workflow orchestration", () => {
  it("creates a fresh Durable Object stub when a Workflow step attempt is retried", async () => {
    const firstAttempt = vi.fn<ProtocolBuilder["protocolVersion"]>(async () => {
      throw new Error("internal error");
    });
    const secondAttempt = vi.fn<ProtocolBuilder["protocolVersion"]>(async () => "kaniko-v2");
    const availableBuilders: ProtocolBuilder[] = [
      { protocolVersion: firstAttempt },
      { protocolVersion: secondAttempt },
    ];
    const getByName = vi.fn<(name: string) => ProtocolBuilder>((name) => {
      expect(name).toBe("runner-image-builder");
      const builder = availableBuilders.shift();
      if (builder === undefined) {
        throw new Error("No fresh builder stub available");
      }
      return builder;
    });
    const operation = () => withFreshRunnerImageBuilder({ getByName }, (builder) => builder.protocolVersion());

    let version: string;
    try {
      version = await operation();
    } catch {
      version = await operation();
    }

    expect(version).toBe("kaniko-v2");
    expect(getByName).toHaveBeenCalledTimes(2);
    expect(firstAttempt).toHaveBeenCalledOnce();
    expect(secondAttempt).toHaveBeenCalledOnce();
  });

  it("checks a Container rollout in separate operations divided by durable sleeps", async () => {
    const statuses: ContainerRolloutStatus[] = ["progressing", "pending", "completed"];
    const events: string[] = [];

    await waitForRunnerImageBuilderRollout(
      { kind: "rollout", applicationId: "application-id", rolloutId: "rollout-id" },
      async (attempt, applicationId, rolloutId) => {
        events.push(`check:${attempt}:${applicationId}:${rolloutId}`);
        const status = statuses.shift();
        if (status === undefined) {
          throw new Error("Missing rollout status");
        }
        return status;
      },
      async (attempt) => {
        events.push(`sleep:${attempt}`);
      },
      10,
    );

    expect(events).toEqual([
      "check:1:application-id:rollout-id",
      "sleep:1",
      "check:2:application-id:rollout-id",
      "sleep:2",
      "check:3:application-id:rollout-id",
    ]);
  });

  it("stops polling at the durable check limit without an extra sleep", async () => {
    const events: string[] = [];

    await expect(
      waitForRunnerImageBuilderRollout(
        { kind: "rollout", applicationId: "application-id", rolloutId: "rollout-id" },
        async (attempt) => {
          events.push(`check:${attempt}`);
          return "progressing";
        },
        async (attempt) => {
          events.push(`sleep:${attempt}`);
        },
        2,
      ),
    ).rejects.toThrow("Cloudflare timed out rolling out the daemonless runner image builder");
    expect(events).toEqual(["check:1", "sleep:1", "check:2"]);
  });

  it("waits durably for the bootstrap Container to stop before its image rollout", async () => {
    const liveInstances = [true, true, false];
    const events: string[] = [];

    await waitForRunnerImageBuilderApplicationIdle(
      async (attempt) => {
        events.push(`check:${attempt}`);
        return liveInstances.shift() ?? false;
      },
      async (attempt) => {
        events.push(`sleep:${attempt}`);
      },
      10,
    );

    expect(events).toEqual(["check:1", "sleep:1", "check:2", "sleep:2", "check:3"]);
  });

  it("bounds the wait for a bootstrap Container that does not stop", async () => {
    const events: string[] = [];

    await expect(
      waitForRunnerImageBuilderApplicationIdle(
        async (attempt) => {
          events.push(`check:${attempt}`);
          return true;
        },
        async (attempt) => {
          events.push(`sleep:${attempt}`);
        },
        2,
      ),
    ).rejects.toThrow("Cloudflare timed out stopping the temporary daemonless runner image builder");
    expect(events).toEqual(["check:1", "sleep:1", "check:2"]);
  });

  it("uses fresh stubs for each cleanup action and never propagates cleanup failures", async () => {
    const events: string[] = [];
    const builders: CleanupBuilder[] = [
      {
        abortBootstrap: async (workflowId) => {
          events.push(`abort-bootstrap:${workflowId}`);
          throw new Error("internal error");
        },
        abortBuild: async () => undefined,
        updateBuildProgress: async () => undefined,
      },
      {
        abortBootstrap: async () => undefined,
        abortBuild: async (workflowId) => {
          events.push(`abort-build:${workflowId}`);
        },
        updateBuildProgress: async () => undefined,
      },
      {
        abortBootstrap: async () => undefined,
        abortBuild: async () => undefined,
        updateBuildProgress: async (workflowId, phase) => {
          events.push(`progress:${workflowId}:${phase}`);
        },
      },
    ];
    const getByName = vi.fn<(name: string) => CleanupBuilder>((name) => {
      expect(name).toBe("runner-image-builder");
      const builder = builders.shift();
      if (builder === undefined) {
        throw new Error("No fresh cleanup stub available");
      }
      return builder;
    });
    const cleanupError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(cleanupFailedRunnerImageBuild({ getByName }, "workflow-id", true)).resolves.toBeUndefined();

      expect(getByName).toHaveBeenCalledTimes(3);
      expect(events).toEqual(["abort-bootstrap:workflow-id", "abort-build:workflow-id", "progress:workflow-id:failed"]);
      expect(cleanupError).toHaveBeenCalledWith("Cloudflare image builder cleanup failed", {
        operation: "abort bootstrap",
        error: "internal error",
      });
    } finally {
      cleanupError.mockRestore();
    }
  });

  it("retains leases for replayable infrastructure failures and cleans up explicit terminal failures", () => {
    const infrastructureFailure = new Error("WorkflowInternalError: request was canceled");
    const terminalFailure = new Error("invalid permanent configuration");
    terminalFailure.name = runnerImageBuildTerminalErrorName;

    expect(runnerImageBuildFailureRequiresCleanup(infrastructureFailure)).toBe(false);
    expect(runnerImageBuildFailureRequiresCleanup(terminalFailure)).toBe(true);
  });
});
