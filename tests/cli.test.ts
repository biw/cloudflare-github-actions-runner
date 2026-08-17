import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

const cli = fileURLToPath(new URL("../bin/cloudflare-github-actions-runner.ts", import.meta.url));
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");

function runCli(...arguments_: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [tsxCli, cli, ...arguments_]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

describe("setup and teardown CLI", { timeout: 15_000 }, () => {
  it("describes the npx setup command without requiring a terminal", async () => {
    await expect(runCli("--help")).resolves.toEqual(
      expect.objectContaining({
        code: 0,
        stderr: "",
        stdout: expect.stringContaining("cloudflare-github-actions-runner setup"),
      }),
    );
  });

  it("describes the teardown command", async () => {
    await expect(runCli("--help")).resolves.toEqual(
      expect.objectContaining({
        code: 0,
        stdout: expect.stringContaining("cloudflare-github-actions-runner teardown"),
      }),
    );
  });

  it("rejects unsupported commands before starting interactive setup", async () => {
    await expect(runCli("deploy")).resolves.toEqual(
      expect.objectContaining({
        code: 1,
        stderr: expect.stringContaining("Unknown command: deploy"),
      }),
    );
  });

  it("starts the TypeScript setup CLI", async () => {
    await expect(runCli("setup")).resolves.toEqual(
      expect.objectContaining({
        code: 1,
        stderr: expect.stringContaining("Setup is interactive and must be run in a terminal"),
      }),
    );
  });

  it("starts setup when no command is provided", async () => {
    await expect(runCli()).resolves.toEqual(
      expect.objectContaining({
        code: 1,
        stderr: expect.stringContaining("Setup is interactive and must be run in a terminal"),
      }),
    );
  });

  it("starts the TypeScript teardown CLI", async () => {
    await expect(runCli("teardown")).resolves.toEqual(
      expect.objectContaining({
        code: 1,
        stderr: expect.stringContaining("Teardown is interactive and must be run in a terminal"),
      }),
    );
  });

  it("rejects unsupported teardown options", async () => {
    await Promise.all(
      ["--dry-run", "--apply", "--force"].map((option) =>
        expect(runCli("teardown", option)).resolves.toEqual(
          expect.objectContaining({
            code: 1,
            stderr: expect.stringContaining("The teardown command does not accept arguments"),
          }),
        ),
      ),
    );
  });
});
