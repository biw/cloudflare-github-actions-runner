import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  deleteGitHubRunner,
  provisionRunner,
  type GitHubRunnerEnvironment,
  type RunnerContainer,
} from "../src/provision";
import { RUNNER_PROFILES } from "../src/runner-profiles";

const environment: GitHubRunnerEnvironment = {
  GITHUB_RUNNER_GROUP_ID: "1",
};
const credentials = { owner: "biw", repository: "cloudflare-github-actions-runner", token: "github-token" };
const standard3 = RUNNER_PROFILES["standard-3"];

function runner(state: "starting" | "running" | "stopped" = "stopped"): RunnerContainer {
  return {
    getState: vi.fn<RunnerContainer["getState"]>().mockResolvedValue({ status: state }),
    start: vi.fn<RunnerContainer["start"]>().mockResolvedValue(undefined),
  };
}

function jitResponse(): Response {
  return Response.json({
    encoded_jit_config: "secret-jit-config",
    runner: { id: 123 },
  });
}

describe("provisionRunner", () => {
  it("creates a JIT runner and supplies its configuration only to the container", async () => {
    const container = runner();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jitResponse());

    const result = await provisionRunner(environment, credentials, container, "cf-container-42-1", standard3, {
      fetch,
    });

    expect(result).toEqual({ kind: "started", runnerName: "cf-container-42-1", runnerId: 123 });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/biw/cloudflare-github-actions-runner/actions/runners/generate-jitconfig",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer github-token",
          "User-Agent": "cloudflare-github-actions-runner",
        }),
      }),
    );
    expect(JSON.parse(z.string().parse(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      name: "cf-container-42-1",
      runner_group_id: 1,
      labels: ["self-hosted", "Linux", "X64", "cloudflare-standard-3", "cloudflare-ubuntu-latest"],
      work_folder: "_work",
    });
    expect(container.start).toHaveBeenCalledWith({
      envVars: {
        ACTIONS_RUNNER_JIT_CONFIG: "secret-jit-config",
        CF_CONTAINER_INSTANCE_TYPE: "standard-3",
        CF_CONTAINER_MEMORY_GIB: "8",
        CF_CONTAINER_DISK_GB: "16",
      },
    });
  });

  it("records the JIT runner before the Container starts accepting GitHub jobs", async () => {
    const events: string[] = [];
    const container: RunnerContainer = {
      getState: vi.fn<RunnerContainer["getState"]>().mockResolvedValue({ status: "stopped" }),
      start: vi.fn<RunnerContainer["start"]>().mockImplementation(async () => {
        events.push("container-started");
      }),
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jitResponse());

    await provisionRunner(environment, credentials, container, "cf-container-42-1", standard3, {
      fetch,
      onJitRunnerCreated: async (runnerId) => {
        events.push(`runner-recorded-${runnerId}`);
      },
    });

    expect(events).toEqual(["runner-recorded-123", "container-started"]);
  });

  it("does not create a new JIT runner while its named container is active", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();

    const result = await provisionRunner(environment, credentials, runner("running"), "cf-container-42-1", standard3, {
      fetch,
    });

    expect(result).toEqual({ kind: "already-active", runnerName: "cf-container-42-1" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes only a runner-scoped resource-trace capability to the container", async () => {
    const container = runner();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jitResponse());

    await provisionRunner(environment, credentials, container, "cf-container-42-1", standard3, {
      fetch,
      resourceTrace: { endpoint: "https://runner.example/v1/resource-traces", authorization: "signed-capability" },
    });

    expect(container.start).toHaveBeenCalledWith(
      expect.objectContaining({
        envVars: expect.objectContaining({
          CF_RESOURCE_TRACE_ENDPOINT: "https://runner.example/v1/resource-traces",
          CF_RESOURCE_TRACE_AUTHORIZATION: "signed-capability",
        }),
      }),
    );
  });

  it("passes a short-lived runner cache capability instead of R2 credentials", async () => {
    const container = runner();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jitResponse());

    await provisionRunner(environment, credentials, container, "cf-container-42-1", standard3, {
      fetch,
      runnerCache: { endpoint: "https://runner.example/v1/runner-cache", authorization: "Bearer capability" },
    });

    expect(container.start).toHaveBeenCalledWith(
      expect.objectContaining({
        envVars: expect.objectContaining({
          CF_RUNNER_CACHE_ENDPOINT: "https://runner.example/v1/runner-cache",
          CF_RUNNER_CACHE_AUTHORIZATION: "Bearer capability",
        }),
      }),
    );
    expect(container.start).not.toHaveBeenCalledWith(
      expect.objectContaining({ envVars: expect.objectContaining({ R2_ACCESS_KEY_ID: expect.anything() }) }),
    );
  });

  it("starts a diagnostic runner with the invalid job's labels and a pre-job failure message", async () => {
    const container = runner();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jitResponse());

    await provisionRunner(environment, credentials, container, "cf-validation-job-42", RUNNER_PROFILES.basic, {
      fetch,
      jitLabels: ["self-hosted", "cloudflare-vcpu:5-memory_mib:12288-disk_mb:20000"],
      jobStartedHookMessage: "- vCPU must be a whole number from 1 through 4.",
    });

    expect(JSON.parse(z.string().parse(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      name: "cf-validation-job-42",
      labels: ["self-hosted", "cloudflare-vcpu:5-memory_mib:12288-disk_mb:20000"],
    });
    expect(container.start).toHaveBeenCalledWith({
      envVars: expect.objectContaining({
        CF_INVALID_RUNNER_MESSAGE: "- vCPU must be a whole number from 1 through 4.",
      }),
    });
  });

  it("returns GitHub failures without trying to start a container", async () => {
    const container = runner();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("Forbidden", { status: 403 }));

    const result = await provisionRunner(environment, credentials, container, "cf-container-42-1", standard3, {
      fetch,
    });

    expect(result).toEqual({ kind: "github-error", status: 403 });
    expect(container.start).not.toHaveBeenCalled();
  });

  it("removes the JIT runner when starting its container fails", async () => {
    const container = runner();
    vi.mocked(container.start).mockRejectedValue(new Error("container unavailable"));
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jitResponse())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await provisionRunner(environment, credentials, container, "cf-container-42-1", standard3, {
      fetch,
    });

    expect(result).toEqual({ kind: "container-start-error", runnerId: 123 });
    expect(fetch).toHaveBeenLastCalledWith(
      "https://api.github.com/repos/biw/cloudflare-github-actions-runner/actions/runners/123",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("removes the JIT runner without starting a Container when its identity cannot be recorded", async () => {
    const container = runner();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jitResponse())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await provisionRunner(environment, credentials, container, "cf-container-42-1", standard3, {
      fetch,
      onJitRunnerCreated: async () => {
        throw new Error("scheduler unavailable");
      },
    });

    expect(result).toEqual({ kind: "container-start-error", runnerId: 123 });
    expect(container.start).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenLastCalledWith(
      "https://api.github.com/repos/biw/cloudflare-github-actions-runner/actions/runners/123",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("reports a busy runner so scheduler recovery can retry it", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 422 }));

    await expect(deleteGitHubRunner(credentials, 123, { fetch })).resolves.toEqual({ kind: "busy" });
  });
});
