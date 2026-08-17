import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = z.object({ port: z.number() }).safeParse(server.address());
  if (!address.success) {
    throw new Error("Could not determine server port");
  }
  return address.data.port;
}

async function close(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}

async function runHook(configurationPath: string | undefined, environment: Record<string, string> = {}) {
  const childEnvironment = { ...process.env, ...environment };
  if (configurationPath !== undefined) {
    childEnvironment.CF_RUNNER_CACHE_ASSIGNMENT_CONFIGURATION_PATH = configurationPath;
  }
  const child = spawn("sh", ["docker/job-started-hook.sh"], {
    cwd: process.cwd(),
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exit = z.array(z.json()).parse(await once(child, "exit"));
  const code = z.number().nullable().parse(exit[0]);
  return { code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
}

describe("runner cache assignment hook", () => {
  it("waits for the GitHub assignment webhook before a cache-enabled job begins", async () => {
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts += 1;
      response.writeHead(attempts === 1 ? 202 : 200).end();
    });
    const port = await listen(server);
    const directory = await mkdtemp(join(tmpdir(), "runner-job-hook-test-"));
    const configurationPath = join(directory, "cache-assignment");
    await writeFile(configurationPath, `http://127.0.0.1:${port}/v1/runner-cache\nBearer runner-capability\n`, {
      mode: 0o600,
    });

    try {
      await expect(runHook(configurationPath)).resolves.toEqual({ code: 0, stdout: "", stderr: "" });
      expect(attempts).toBe(2);
      await expect(readFile(configurationPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await close(server);
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);

  it("fails closed on an unexpected Worker status and never prints the runner capability", async () => {
    const server = createServer((_request, response) => response.writeHead(401).end());
    const port = await listen(server);
    const directory = await mkdtemp(join(tmpdir(), "runner-job-hook-test-"));
    const configurationPath = join(directory, "cache-assignment");
    const capability = "Bearer capability-that-must-not-leak";
    await writeFile(configurationPath, `http://127.0.0.1:${port}/v1/runner-cache\n${capability}\n`, { mode: 0o600 });

    try {
      await expect(runHook(configurationPath)).resolves.toEqual({
        code: 1,
        stdout:
          "::error title=Cloudflare runner cache assignment::The Worker returned HTTP 401 while waiting for GitHub's runner assignment.\n",
        stderr: "",
      });
      await expect(readFile(configurationPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await close(server);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed after the bounded wait window when GitHub never sends an assignment", async () => {
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts += 1;
      response.writeHead(202).end();
    });
    const port = await listen(server);
    const directory = await mkdtemp(join(tmpdir(), "runner-job-hook-test-"));
    const configurationPath = join(directory, "cache-assignment");
    await writeFile(configurationPath, `http://127.0.0.1:${port}/v1/runner-cache\nBearer runner-capability\n`, {
      mode: 0o600,
    });

    try {
      await expect(
        runHook(configurationPath, {
          CF_RUNNER_CACHE_ASSIGNMENT_MAX_ATTEMPTS: "2",
          CF_RUNNER_CACHE_ASSIGNMENT_POLL_SECONDS: "0",
        }),
      ).resolves.toEqual({
        code: 1,
        stdout:
          "::error title=Cloudflare runner cache assignment::GitHub's runner assignment was not observed within 2 seconds.\n",
        stderr: "",
      });
      expect(attempts).toBe(2);
      await expect(readFile(configurationPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await close(server);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not start a job when the one-time cache configuration is malformed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runner-job-hook-test-"));
    const configurationPath = join(directory, "cache-assignment");
    const capability = "Bearer malformed-configuration-capability";
    await writeFile(configurationPath, `\n${capability}\n`, { mode: 0o600 });

    try {
      const result = await runHook(configurationPath);
      expect(result).toEqual({
        code: 1,
        stdout:
          "::error title=Cloudflare runner cache assignment::The runner cache capability was invalid before this job started.\n",
        stderr: "",
      });
      expect(`${result.stdout}${result.stderr}`).not.toContain(capability);
      await expect(readFile(configurationPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not block jobs when R2 cache support was intentionally not configured", async () => {
    await expect(runHook(undefined)).resolves.toEqual({ code: 0, stdout: "", stderr: "" });
  });
});
