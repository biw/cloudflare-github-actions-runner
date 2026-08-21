import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vite-plus/test";

describe("runner image", () => {
  it("keeps supported action runtimes while pruning Alpine-only copies", async () => {
    const dockerfile = await readFile("docker/Dockerfile", "utf8");
    const finalImage = dockerfile.lastIndexOf("FROM ubuntu:24.04");
    const prune = dockerfile.indexOf("/opt/actions-runner-source/_layout/externals/node20_alpine");
    const runtimeCheck = dockerfile.indexOf("test -x /opt/actions-runner-source/_layout/externals/node20/bin/node");
    const pruneBlock = dockerfile.slice(runtimeCheck, dockerfile.indexOf("\n\n", runtimeCheck));

    expect(finalImage).toBeGreaterThan(0);
    expect(prune).toBeGreaterThan(0);
    expect(prune).toBeLessThan(finalImage);
    expect(runtimeCheck).toBeGreaterThan(0);
    expect(pruneBlock).toContain("/opt/actions-runner-source/_layout/externals/node20_alpine");
    expect(pruneBlock).toContain("/opt/actions-runner-source/_layout/externals/node24_alpine");
    expect(pruneBlock).not.toMatch(/\/externals\/node20\s*(?:\\|\r?\n)/);
    expect(dockerfile).toContain("FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true");
    expect(dockerfile).toContain("test -x /opt/actions-runner-source/_layout/externals/node20/bin/node");
    expect(dockerfile).toContain("test -x /opt/actions-runner-source/_layout/externals/node24/bin/node");
    expect(dockerfile).not.toContain("ln --symbolic node24 /home/runner/actions-runner/externals/node20");
    expect(dockerfile).toContain("chown runner:runner /home/runner/actions-runner");
    expect(dockerfile).toContain('chown --recursive runner:runner "${RUNNER_TOOL_CACHE}"');
    expect(dockerfile).not.toContain('chown --recursive runner:runner /home/runner "${RUNNER_TOOL_CACHE}"');
  });

  it("installs Git from git-core for GitHub-hosted runner parity", async () => {
    const dockerfile = await readFile("docker/Dockerfile", "utf8");

    const repository = dockerfile.indexOf("add-apt-repository --yes ppa:git-core/ppa");
    const gitInstall = dockerfile.indexOf("apt-get install --yes --no-install-recommends git git-lfs", repository);

    expect(repository).toBeGreaterThan(0);
    expect(gitInstall).toBeGreaterThan(repository);
  });
});
