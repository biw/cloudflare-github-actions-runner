import { describe, expect, it } from "vite-plus/test";

import {
  githubOwnerLabel,
  githubRunnerOwnerFromWorkerSettings,
  orderedGitHubRunnerOwners,
  type GitHubRunnerOwner,
} from "../scripts/setup.ts";

describe("GitHub runner owner setup selection", () => {
  it("defaults to and labels the existing GitHub owner", () => {
    const owners: GitHubRunnerOwner[] = [
      { type: "personal", login: "biw" },
      { type: "organization", login: "ahoylabs", name: "Ahoy Labs" },
    ];

    expect(githubRunnerOwnerFromWorkerSettings({ bindings: [{ name: "GITHUB_RUNNER_OWNER", text: "ahoylabs" }] })).toBe(
      "ahoylabs",
    );
    expect(orderedGitHubRunnerOwners(owners, "AhoyLabs")).toEqual([
      { owner: owners[1], previouslyConfigured: true },
      { owner: owners[0], previouslyConfigured: false },
    ]);
    expect(githubOwnerLabel(owners[0], { previouslyConfigured: true })).toBe("personal: biw (previously configured)");
    expect(githubOwnerLabel(owners[1])).toBe("org: Ahoy Labs (ahoylabs)");
  });
});
