import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vite-plus/test";

describe("runner image", () => {
  it("keeps obsolete action runtimes out of the final image", async () => {
    const dockerfile = await readFile("docker/Dockerfile", "utf8");
    const finalImage = dockerfile.lastIndexOf("FROM ubuntu:24.04");
    const prune = dockerfile.indexOf("/opt/actions-runner-source/_layout/externals/node20");

    expect(finalImage).toBeGreaterThan(0);
    expect(prune).toBeGreaterThan(0);
    expect(prune).toBeLessThan(finalImage);
    expect(dockerfile).toContain("/opt/actions-runner-source/_layout/externals/node20_alpine");
    expect(dockerfile).toContain("/opt/actions-runner-source/_layout/externals/node24_alpine");
    expect(dockerfile).toContain("FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true");
    expect(dockerfile).toContain("test -x /opt/actions-runner-source/_layout/externals/node24/bin/node");
    expect(dockerfile).toContain("chown runner:runner /home/runner/actions-runner");
    expect(dockerfile).toContain('chown --recursive runner:runner "${RUNNER_TOOL_CACHE}"');
    expect(dockerfile).not.toContain('chown --recursive runner:runner /home/runner "${RUNNER_TOOL_CACHE}"');
  });
});
