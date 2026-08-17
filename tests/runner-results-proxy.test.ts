import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Buffer as NodeBuffer } from "node:buffer";

import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

async function requestBody(request: AsyncIterable<Uint8Array>): Promise<NodeBuffer> {
  const chunks: NodeBuffer[] = [];
  for await (const chunk of request) {
    chunks.push(NodeBuffer.from(chunk));
  }
  return NodeBuffer.concat(chunks);
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = z.object({ port: z.number() }).safeParse(server.address());
  if (!address.success) {
    throw new Error("Could not determine test server port");
  }
  return address.data.port;
}

async function close(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}

async function waitForProxy(origin: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- the health check is deliberately retried in order.
      if ((await fetch(`${origin}/healthz`)).ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    // eslint-disable-next-line no-await-in-loop -- the child process needs a brief startup window.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw lastError instanceof Error ? lastError : new Error("Runner cache proxy did not start");
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

describe("runner results proxy cache uploads", () => {
  it("splits a direct Actions cache archive upload into Worker-safe multipart blocks and forwards non-cache Results APIs", async () => {
    const uploads: Array<{ blockId: string; body: string; authorization: string | undefined }> = [];
    const forwardedResults: Array<{ authorization: string | undefined; body: string; method: string; path: string }> =
      [];
    let completedParts: unknown;
    const worker = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://worker.test");
      if (request.method === "PUT" && url.pathname === "/v1/runner-cache-v2/upload") {
        const blockId = url.searchParams.get("block_id");
        if (blockId === null) {
          response.writeHead(400).end();
          return;
        }
        uploads.push({
          blockId,
          body: new TextDecoder().decode(await requestBody(request)),
          authorization: request.headers.authorization,
        });
        response
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ ok: true, partNumber: uploads.length, etag: `etag-${uploads.length}` }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/runner-cache-v2/complete") {
        completedParts = JSON.parse(new TextDecoder().decode(await requestBody(request))).parts;
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(404).end();
    });
    const workerPort = await listen(worker);
    const upstream = createServer(async (request, response) => {
      forwardedResults.push({
        authorization: request.headers.authorization,
        body: new TextDecoder().decode(await requestBody(request)),
        method: request.method ?? "",
        path: request.url ?? "",
      });
      response.writeHead(201, { "X-Upstream-Result": "preserved" }).end("artifact-created");
    });
    const upstreamPort = await listen(upstream);
    const directory = await mkdtemp(join(tmpdir(), "runner-results-proxy-test-"));
    const configurationPath = join(directory, "cache-configuration");
    const upstreamPath = join(directory, "results-upstream");
    await writeFile(configurationPath, `http://127.0.0.1:${workerPort}\nBearer runner-capability\n`);
    await writeFile(upstreamPath, `http://127.0.0.1:${upstreamPort}`);

    const portServer = createServer();
    const proxyPort = await listen(portServer);
    await close(portServer);
    const origin = `http://127.0.0.1:${proxyPort}`;
    const child = spawn(process.execPath, ["docker/runner-results-proxy.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CF_RUNNER_RESULTS_PROXY_PORT: String(proxyPort),
        CF_RUNNER_RESULTS_PROXY_URL: origin,
        CF_RUNNER_RESULTS_PROXY_CONFIGURATION_PATH: configurationPath,
        CF_RUNNER_RESULTS_PROXY_UPSTREAM_PATH: upstreamPath,
        CF_RUNNER_CACHE_UPLOAD_PART_BYTES: String(5 * 1024 * 1024),
      },
      stdio: "ignore",
    });

    try {
      await waitForProxy(origin);
      await expect(rm(configurationPath)).rejects.toMatchObject({ code: "ENOENT" });
      const archive = Buffer.alloc(10 * 1024 * 1024 + 3, "a");
      archive.set(Buffer.from("end"), archive.length - 3);
      const response = await fetch(`${origin}/cache-upload/session-1`, {
        method: "PUT",
        headers: { "Content-Type": "application/zstd" },
        body: archive,
      });

      expect(response.status).toBe(201);
      expect(uploads).toHaveLength(3);
      expect(uploads.map((upload) => upload.body.length)).toEqual([5 * 1024 * 1024, 5 * 1024 * 1024, 3]);
      expect(uploads.map((upload) => upload.authorization)).toEqual([
        "Bearer runner-capability",
        "Bearer runner-capability",
        "Bearer runner-capability",
      ]);
      expect(completedParts).toEqual([
        { blockId: Buffer.from("cloudflare-cache-000000").toString("base64"), partNumber: 1, etag: "etag-1" },
        { blockId: Buffer.from("cloudflare-cache-000001").toString("base64"), partNumber: 2, etag: "etag-2" },
        { blockId: Buffer.from("cloudflare-cache-000002").toString("base64"), partNumber: 3, etag: "etag-3" },
      ]);

      const artifact = await fetch(`${origin}/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact`, {
        method: "POST",
        headers: {
          Authorization: "Bearer github-job-token",
          "Content-Type": "application/json",
          "X-GitHub-Result-Header": "must-survive-proxying",
        },
        body: '{"name":"build-output"}',
      });
      expect({
        body: await artifact.text(),
        status: artifact.status,
        upstreamHeader: artifact.headers.get("x-upstream-result"),
      }).toEqual({ body: "artifact-created", status: 201, upstreamHeader: "preserved" });
      expect(forwardedResults).toEqual([
        {
          authorization: "Bearer github-job-token",
          body: '{"name":"build-output"}',
          method: "POST",
          path: "/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact",
        },
      ]);
    } finally {
      await stop(child);
      await close(worker);
      await close(upstream);
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
