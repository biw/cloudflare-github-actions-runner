import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vite-plus/test";

const prepareScript = fileURLToPath(new URL("../scripts/prepare.mjs", import.meta.url));
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function runPrepare(ci: string, githubActions: string, installerExitCode = 0) {
  const directory = await mkdtemp(join(tmpdir(), "runner-prepare-test-"));
  directories.push(directory);
  const fixture = join(directory, "installer.cjs");
  await writeFile(
    fixture,
    "console.log(JSON.stringify(process.argv.slice(2)));\nprocess.exit(Number(process.env.SKILLS_TEST_EXIT_CODE));\n",
  );
  await writeFile(
    join(directory, process.platform === "win32" ? "pnpx.cmd" : "pnpx"),
    process.platform === "win32"
      ? '@"%SKILLS_TEST_NODE_PATH%" "%SKILLS_TEST_FIXTURE_PATH%" %*\r\n'
      : '#!/bin/sh\nexec "$SKILLS_TEST_NODE_PATH" "$SKILLS_TEST_FIXTURE_PATH" "$@"\n',
    { mode: 0o755 },
  );

  return spawnSync(process.execPath, [prepareScript], {
    env: {
      ...process.env,
      CI: ci,
      GITHUB_ACTIONS: githubActions,
      PATH: directory,
      SKILLS_TEST_EXIT_CODE: String(installerExitCode),
      SKILLS_TEST_NODE_PATH: process.execPath,
      SKILLS_TEST_FIXTURE_PATH: fixture,
    },
    encoding: "utf8",
  });
}

describe("package preparation", () => {
  it.each([
    ["true", ""],
    ["1", ""],
    ["", "true"],
  ])("skips the external installer with CI=%s and GITHUB_ACTIONS=%s", async (ci, githubActions) => {
    const result = await runPrepare(ci, githubActions, 17);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Skipping agent skill installation in CI.\n");
    expect(result.stderr).toBe("");
  });

  it("preserves local installation and forwards the installer arguments", async () => {
    const result = await runPrepare("", "");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('["skills","experimental_install"]\n');
    expect(result.stderr).toBe("");
  });

  it("propagates a failed local installation", async () => {
    const result = await runPrepare("", "", 17);

    expect(result.status).toBe(17);
    expect(result.stdout).toBe('["skills","experimental_install"]\n');
  });
});
