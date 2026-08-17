import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  authorizeGitHubRepositoryWithToken,
  createOrRecoverGitHubEligibilityCheck,
  fetchGitHubRepositoryVisibility,
  updateGitHubEligibilityCheck,
  type EligibilityCheckReporter,
  type RunnerEligibilityDependencies,
  type RunnerEligibilityInput,
} from "../../src/runner-eligibility";

const target = { owner: "ahoylabs", repository: "runner-test" };
const input: RunnerEligibilityInput = {
  jobId: "94035733533",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  target,
  installationId: 42,
};

function dependencies(fetch: RunnerEligibilityDependencies["fetch"]): RunnerEligibilityDependencies {
  return { fetch, now: () => 1_700_000_000_000 };
}

describe("private repository runner eligibility", () => {
  it("persists the first job identity and rejects a conflicting repository or head SHA", async () => {
    const eligibility = env.RUNNER_ELIGIBILITY_CHECK.getByName("stable-job-identity");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const missingInstallation = { ...input, installationId: null };

    await expect(eligibility.authorize(missingInstallation)).resolves.toEqual({
      kind: "rejected",
      visibility: "unverifiable",
      checkReported: false,
    });
    await expect(
      eligibility.authorize({
        ...missingInstallation,
        headSha: "different-head-sha",
        target: { owner: "ahoylabs", repository: "different-repository" },
      }),
    ).resolves.toEqual({ kind: "rejected", visibility: "unverifiable", checkReported: false });

    const stored = await runInDurableObject(eligibility, async (_instance, state) =>
      state.storage.sql
        .exec<{ github_repository: string; head_sha: string }>(
          "SELECT github_repository, head_sha FROM eligibility_check WHERE singleton = 1",
        )
        .one(),
    );
    expect(stored).toEqual({ github_repository: input.target.repository, head_sha: input.headSha });
    error.mockRestore();
  });

  it.each(["private", "public", "internal"] as const)("uses GitHub's exact %s visibility", async (visibility) => {
    const fetch = vi.fn<RunnerEligibilityDependencies["fetch"]>().mockResolvedValue(Response.json({ visibility }));

    await expect(fetchGitHubRepositoryVisibility(target, "token", dependencies(fetch))).resolves.toBe(visibility);
  });

  it("treats a malformed visibility response as unverifiable", async () => {
    const fetch = vi
      .fn<RunnerEligibilityDependencies["fetch"]>()
      .mockResolvedValue(Response.json({ private: true, visibility: "enterprise" }));

    await expect(fetchGitHubRepositoryVisibility(target, "token", dependencies(fetch))).resolves.toBeUndefined();
  });

  it("permits exactly private visibility without reporting an eligibility Check", async () => {
    const fetch = vi
      .fn<RunnerEligibilityDependencies["fetch"]>()
      .mockResolvedValue(Response.json({ visibility: "private" }));
    const reportCheck = vi.fn<EligibilityCheckReporter>();

    await expect(authorizeGitHubRepositoryWithToken(input, "token", reportCheck, dependencies(fetch))).resolves.toEqual(
      { kind: "private" },
    );
    expect(reportCheck).not.toHaveBeenCalled();
  });

  it.each(["public", "internal"] as const)(
    "rejects %s visibility and reports one eligibility Check",
    async (visibility) => {
      const fetch = vi.fn<RunnerEligibilityDependencies["fetch"]>().mockResolvedValue(Response.json({ visibility }));
      const reportCheck = vi.fn<EligibilityCheckReporter>().mockResolvedValue(true);

      await expect(
        authorizeGitHubRepositoryWithToken(input, "token", reportCheck, dependencies(fetch)),
      ).resolves.toEqual({ kind: "rejected", visibility, checkReported: true });
      expect(reportCheck).toHaveBeenCalledExactlyOnceWith(visibility);
    },
  );

  it.each([
    ["malformed response", Response.json({ visibility: "enterprise" })],
    ["GitHub API error", new Response(null, { status: 503 })],
  ])("fails closed after a %s", async (_name, response) => {
    const fetch = vi.fn<RunnerEligibilityDependencies["fetch"]>().mockResolvedValue(response);
    const reportCheck = vi.fn<EligibilityCheckReporter>().mockResolvedValue(true);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(authorizeGitHubRepositoryWithToken(input, "token", reportCheck, dependencies(fetch))).resolves.toEqual(
      { kind: "rejected", visibility: "unverifiable", checkReported: true },
    );
    expect(reportCheck).toHaveBeenCalledExactlyOnceWith("unverifiable");
    error.mockRestore();
  });

  it("preserves rejection when GitHub refuses the eligibility Check", async () => {
    const fetch = vi
      .fn<RunnerEligibilityDependencies["fetch"]>()
      .mockResolvedValue(Response.json({ visibility: "public" }));
    const reportCheck = vi.fn<EligibilityCheckReporter>().mockRejectedValue(new Error("forbidden"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(authorizeGitHubRepositoryWithToken(input, "token", reportCheck, dependencies(fetch))).resolves.toEqual(
      { kind: "rejected", visibility: "public", checkReported: false },
    );
    error.mockRestore();
  });

  it("reports an unsupported repository with the stable eligibility Check contract", async () => {
    const fetch = vi
      .fn<RunnerEligibilityDependencies["fetch"]>()
      .mockResolvedValueOnce(Response.json({ total_count: 0, check_runs: [] }))
      .mockResolvedValueOnce(
        Response.json({ id: 99, external_id: "cloudflare-runner-eligibility:94035733533" }, { status: 201 }),
      );

    await expect(
      createOrRecoverGitHubEligibilityCheck(input, "public", "token", "123", dependencies(fetch)),
    ).resolves.toBe(99);

    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/ahoylabs/runner-test/commits/0123456789abcdef0123456789abcdef01234567/check-runs?check_name=Cloudflare+runner+eligibility&filter=all&per_page=100&page=1&app_id=123",
    );
    expect(fetch.mock.calls[1]?.[0]).toBe("https://api.github.com/repos/ahoylabs/runner-test/check-runs");
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      name: "Cloudflare runner eligibility",
      head_sha: input.headSha,
      status: "completed",
      conclusion: "failure",
      external_id: "cloudflare-runner-eligibility:94035733533",
      details_url: "https://github.com/biw/cloudflare-github-actions-runner#private-repositories-only",
      output: {
        title: "Cloudflare runners require a private repository",
        summary:
          "Cloudflare runner did not start.\n\nahoylabs/runner-test is public. cloudflare-github-actions-runner supports private repositories only. Use another runs-on label or change the repository visibility to private.",
      },
    });
  });

  it("recovers an interrupted Check write by external identity instead of creating a duplicate", async () => {
    const fetch = vi
      .fn<RunnerEligibilityDependencies["fetch"]>()
      .mockResolvedValueOnce(
        Response.json({
          total_count: 1,
          check_runs: [{ id: 99, external_id: "cloudflare-runner-eligibility:94035733533" }],
        }),
      )
      .mockResolvedValueOnce(Response.json({ id: 99 }));

    await expect(
      createOrRecoverGitHubEligibilityCheck(input, "internal", "token", "123", dependencies(fetch)),
    ).resolves.toBe(99);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[0]).toBe("https://api.github.com/repos/ahoylabs/runner-test/check-runs/99");
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "PATCH" });
  });

  it("updates the existing Check without attempting to move it to another commit", async () => {
    const fetch = vi.fn<RunnerEligibilityDependencies["fetch"]>().mockResolvedValue(Response.json({ id: 99 }));

    await expect(updateGitHubEligibilityCheck(input, "unverifiable", "token", 99, dependencies(fetch))).resolves.toBe(
      "updated",
    );

    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body).not.toHaveProperty("head_sha");
    expect(body).toMatchObject({
      name: "Cloudflare runner eligibility",
      status: "completed",
      conclusion: "failure",
      external_id: "cloudflare-runner-eligibility:94035733533",
      output: {
        title: "Cloudflare runners require a private repository",
        summary: expect.stringContaining("current visibility could not be verified"),
      },
    });
  });

  it("does not turn a Checks API failure into a successful report", async () => {
    const fetch = vi
      .fn<RunnerEligibilityDependencies["fetch"]>()
      .mockResolvedValue(new Response(null, { status: 403 }));

    await expect(
      createOrRecoverGitHubEligibilityCheck(input, "public", "token", "123", dependencies(fetch)),
    ).rejects.toThrow("eligibility-check-list request failed with status 403");
  });
});
