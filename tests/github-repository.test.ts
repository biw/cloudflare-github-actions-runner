import { describe, expect, it } from "vite-plus/test";

import {
  githubRepositoryName,
  githubRunnerTokenBindingName,
  githubRunnerTokenFor,
  parseGitHubRepositoryTarget,
  runnerPoolAcceptsGitHubRepository,
} from "../src/github-repository";

describe("GitHub repository credential routing", () => {
  it("limits a runner pool to its configured GitHub account or organization", () => {
    expect(
      runnerPoolAcceptsGitHubRepository(
        { GITHUB_RUNNER_OWNER: "ahoylabs" },
        { owner: "AhoyLabs", repository: "application" },
      ),
    ).toBe(true);
    expect(
      runnerPoolAcceptsGitHubRepository(
        { GITHUB_RUNNER_OWNER: "ahoylabs" },
        { owner: "biw", repository: "application" },
      ),
    ).toBe(false);
    expect(runnerPoolAcceptsGitHubRepository({}, { owner: "biw", repository: "application" })).toBe(false);
  });

  it("normalizes and validates repository targets", () => {
    expect(parseGitHubRepositoryTarget("octo-org/runner-poc")).toEqual({ owner: "octo-org", repository: "runner-poc" });
    expect(parseGitHubRepositoryTarget("octo-org")).toBeUndefined();
    expect(parseGitHubRepositoryTarget("octo-org/runner-poc/extra")).toBeUndefined();
    expect(githubRepositoryName({ owner: "octo-org", repository: "runner-poc" })).toBe("octo-org/runner-poc");
  });

  it("uses a separate secret binding for each GitHub owner", async () => {
    const biwBinding = await githubRunnerTokenBindingName("biw");
    const orgBinding = await githubRunnerTokenBindingName("octo-org");
    const env = { [biwBinding]: "biw-token", [orgBinding]: "org-token" };

    await expect(githubRunnerTokenFor(env, { owner: "biw", repository: "one" })).resolves.toBe("biw-token");
    await expect(githubRunnerTokenFor(env, { owner: "octo-org", repository: "two" })).resolves.toBe("org-token");
    await expect(githubRunnerTokenFor(env, { owner: "missing", repository: "three" })).resolves.toBeUndefined();
  });

  it("uses the original POC token only for its original repository", async () => {
    const env = {
      LEGACY_GITHUB_OWNER: "biw",
      LEGACY_GITHUB_REPOSITORY: "runner-poc",
      GITHUB_RUNNER_TOKEN: "legacy-token",
    };

    await expect(githubRunnerTokenFor(env, { owner: "biw", repository: "runner-poc" })).resolves.toBe("legacy-token");
    await expect(
      githubRunnerTokenFor(env, { owner: "biw", repository: "another-repository" }),
    ).resolves.toBeUndefined();
  });
});
