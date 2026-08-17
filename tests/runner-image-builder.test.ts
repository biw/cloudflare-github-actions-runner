import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@cloudflare/containers", () => ({ Container: class {} }));

import { runOneShotRunnerImageBuilder } from "../src/one-shot-runner-image-builder";
import { RunnerImageBuilder } from "../src/runner-image-builder";
import {
  runnerImageBuilderCommand,
  runnerImageBuilderEntrypoint,
  runnerImageBuilderExitCode,
  runnerImageBuilderExitError,
} from "../src/runner-image-builder-command";

function durableBuilderHarness() {
  const values = new Map<string, object>();
  const storage = {
    delete: async (key: string): Promise<void> => {
      values.delete(key);
    },
    get: async (key: string): Promise<object | undefined> => values.get(key),
    put: async <Value extends object>(key: string, value: Value): Promise<void> => {
      values.set(key, value);
    },
  };
  const harness = {
    ctx: { storage },
    bootstrapDeploymentId: (): string => "deployment-id",
    bootstrapReference: (): string => "registry.cloudflare.com/account/runner-image-builder:kaniko-v1",
  };
  const builder = Object.assign(Object.create(RunnerImageBuilder.prototype), harness);

  return {
    abortBootstrap: (workflowId: string): Promise<void> =>
      RunnerImageBuilder.prototype.abortBootstrap.call(builder, workflowId),
    beginBootstrap: (workflowId: string): Promise<boolean> =>
      RunnerImageBuilder.prototype.beginBootstrap.call(builder, workflowId),
    beginRollOut: (workflowId: string, image: string) =>
      RunnerImageBuilder.prototype.beginRollOut.call(builder, workflowId, image),
    completeRollOutAttempt: (workflowId: string, image: string): Promise<void> =>
      RunnerImageBuilder.prototype.completeRollOutAttempt.call(builder, workflowId, image),
    renewBootstrap: (workflowId: string): Promise<void> =>
      RunnerImageBuilder.prototype.renewBootstrap.call(builder, workflowId),
    values,
  };
}

describe("one-shot Cloudflare runner-image builder", () => {
  it("keeps the detached builder alive beyond the maximum image-build window", () => {
    // SAFETY: The mocked Container constructor does not inspect either argument, and this test reads only a class field.
    const builder = new RunnerImageBuilder({} as never, {} as never);

    expect(builder.sleepAfter).toBe("2h");
  });

  it("lets a waiting Workflow take over a bootstrap claim released by its failed owner", async () => {
    const builder = durableBuilderHarness();

    await expect(builder.beginBootstrap("first-workflow")).resolves.toBe(true);
    await expect(builder.beginBootstrap("waiting-workflow")).resolves.toBe(false);
    await builder.abortBootstrap("first-workflow");
    await expect(builder.beginBootstrap("waiting-workflow")).resolves.toBe(true);
  });

  it("renews the private-builder bootstrap claim across long external operations", async () => {
    const builder = durableBuilderHarness();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      await builder.beginBootstrap("owner");
      vi.advanceTimersByTime(59 * 60 * 1_000);
      await builder.renewBootstrap("owner");
      vi.advanceTimersByTime(59 * 60 * 1_000);

      await expect(builder.beginBootstrap("waiting-workflow")).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the temporary bootstrap Container before changing its application image", async () => {
    const destroy = vi.fn<(reason: string) => Promise<void>>(async () => undefined);
    // SAFETY: The test supplies the only superclass field used by stopForBootstrapRollout and invokes no constructor behavior.
    const builder = Object.assign(Object.create(RunnerImageBuilder.prototype), {
      ctx: { container: { running: true, destroy } },
    }) as RunnerImageBuilder;

    await builder.stopForBootstrapRollout();

    expect(destroy).toHaveBeenCalledWith("Preparing the private daemonless builder image rollout");
  });

  it("reissues matching image rollouts only after an interrupted external rollout attempt", async () => {
    const builder = durableBuilderHarness();
    const image = "registry.cloudflare.com/account/runner:runner-0123456789abcdef01234567";
    builder.values.set("runner-image-build-state", {
      workflowId: "workflow",
      sourceArchiveKey: "runner-image-source/workflow.tar.gz",
      state: "complete",
      result: { sourceDigest: "0123456789abcdef01234567", imageReference: image, built: true },
    });

    await expect(builder.beginRollOut("workflow", image)).resolves.toEqual({
      acquired: true,
      reissueMatchingImageRollouts: false,
    });
    // A retry after the Workflow stopped in the external API call is
    // ambiguous, so it must reissue the matching image rollout.
    await expect(builder.beginRollOut("workflow", image)).resolves.toEqual({
      acquired: true,
      reissueMatchingImageRollouts: true,
    });
    await builder.completeRollOutAttempt("workflow", image);
    // A completed pass which merely deferred a busy runner is unambiguous.
    await expect(builder.beginRollOut("workflow", image)).resolves.toEqual({
      acquired: true,
      reissueMatchingImageRollouts: false,
    });
  });

  it("destroys a started builder after an exec failure, including a stale builder it replaced", async () => {
    const destroy = vi.fn<(reason: string) => Promise<void>>(async () => undefined);
    const start = vi.fn<() => Promise<void>>(async () => undefined);
    const work = vi.fn<() => Promise<never>>(async () => {
      throw new Error("exec failed");
    });

    await expect(runOneShotRunnerImageBuilder({ running: true, destroy }, start, work)).rejects.toThrow("exec failed");

    expect(start).toHaveBeenCalledOnce();
    expect(work).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenNthCalledWith(1, "Superseded by a newer Cloudflare runner image build");
    expect(destroy).toHaveBeenNthCalledWith(2, "Cloudflare runner image build completed");
  });

  it("preserves a build failure if best-effort Container cleanup also fails", async () => {
    const cleanupError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const buildError = new Error("Docker build failed");
    try {
      await expect(
        runOneShotRunnerImageBuilder(
          { running: false, destroy: async () => Promise.reject(new Error("destroy failed")) },
          async () => undefined,
          async () => {
            throw buildError;
          },
        ),
      ).rejects.toBe(buildError);
      expect(cleanupError).toHaveBeenCalledWith(
        "Cloudflare image builder could not destroy its temporary Container",
        expect.objectContaining({ error: "destroy failed" }),
      );
    } finally {
      cleanupError.mockRestore();
    }
  });

  it("adds a specific error when the platform cannot report the Container state", async () => {
    const destroy = vi.fn<(reason: string) => Promise<void>>(async () => undefined);
    const container = {
      get running(): boolean {
        throw new Error("internal error");
      },
      destroy,
    };

    await expect(
      runOneShotRunnerImageBuilder(
        container,
        async () => undefined,
        async () => undefined,
      ),
    ).rejects.toThrow("Cloudflare image builder could not inspect its Container state");
    expect(destroy).toHaveBeenCalledWith("Recovering an unreachable Cloudflare runner image builder");
  });

  it("runs the daemonless image build through exec without Docker-in-Docker", () => {
    const script = runnerImageBuilderCommand();

    expect(runnerImageBuilderEntrypoint()).toEqual(["/busybox/sh", "-c", "exec sleep 2147483647"]);
    expect(script).toContain("/kaniko/executor --force");
    expect(script).toContain("--custom-platform linux/amd64");
    expect(script).toContain('--destination "$RUNNER_IMAGE_REFERENCE"');
    expect(script).toContain("--insecure-registry registry.cloudflare.com");
    expect(script).toContain("--insecure-registry index.docker.io");
    expect(script).toContain("--insecure-registry registry-1.docker.io");
    expect(script).toContain("--insecure-registry auth.docker.io");
    expect(script).toContain('--ignore-path "$workspace"');
    expect(script).toContain("RUNNER_IMAGE_BUILD_DETACHED");
    expect(script).toContain("RUNNER_IMAGE_SOURCE_URL");
    expect(script).toContain("RUNNER_IMAGE_REPOSITORY");
    expect(script).toContain("RUNNER_IMAGE_REGISTRY_MANIFEST_URL");
    expect(script).toContain("source_digest=");
    expect(script).toContain("export workspace source_digest RUNNER_IMAGE_REFERENCE");
    expect(script).toContain("--spider");
    expect(script).toContain('"$workspace/busybox" setsid');
    expect(script).not.toContain("GITHUB_ARCHIVE_TOKEN");
    expect(script).not.toContain("/kaniko/.docker/config.json");
    expect(script).not.toContain("dockerd-entrypoint.sh");
    expect(script).not.toContain("docker build");
    expect(script).not.toContain("docker login");
    expect(spawnSync("sh", ["-n"], { input: script }).status).toBe(0);
  });

  it("turns known batch exit statuses into non-sensitive setup failures", () => {
    expect(runnerImageBuilderExitError(10)).toContain("download the configured GitHub source archive");
    expect(runnerImageBuilderExitError(13)).toContain("build and push the runner image");
    expect(runnerImageBuilderExitError(99)).toBe(
      "Cloudflare image builder could not complete its remote image build process (exit status 99)",
    );
    expect(runnerImageBuilderExitCode(13)).toBe(13);
    expect(runnerImageBuilderExitCode(Number.NaN)).toBe(1);
  });

  it("stages an isolated context and reports each daemonless command-stage failure", () => {
    const script = runnerImageBuilderCommand();

    expect(script).toContain('/busybox/cp /busybox/sh "$workspace/busybox"');
    expect(script).not.toContain("CF_REGISTRY_PASSWORD");
    expect(script).not.toContain("CF_REGISTRY_USERNAME");
    expect(script).not.toContain("GITHUB_ARCHIVE_TOKEN");
    expect(script).toContain("|| exit 10");
    expect(script).toContain("|| exit 11");
    expect(script).toContain("|| return 13");
  });
});
