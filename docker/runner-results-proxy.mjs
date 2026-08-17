#!/usr/bin/env node

import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import { Readable } from "node:stream";

const listenHost = "127.0.0.1";
const listenPort = Number.parseInt(process.env.CF_RUNNER_RESULTS_PROXY_PORT ?? "8790", 10);
const configurationPath = process.env.CF_RUNNER_RESULTS_PROXY_CONFIGURATION_PATH;
const upstreamPath = process.env.CF_RUNNER_RESULTS_PROXY_UPSTREAM_PATH;
const proxyOrigin = process.env.CF_RUNNER_RESULTS_PROXY_URL ?? `http://${listenHost}:${listenPort}`;
const cacheServicePrefix = "/twirp/github.actions.results.api.v1.CacheService/";
const uploadPathPrefix = "/cache-upload/";
const cacheUploadPartBytes = Number.parseInt(process.env.CF_RUNNER_CACHE_UPLOAD_PART_BYTES ?? "8388608", 10);
const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

if (!Number.isSafeInteger(listenPort) || listenPort < 1 || listenPort > 65_535) {
  throw new Error("CF_RUNNER_RESULTS_PROXY_PORT must be a valid TCP port");
}
if (!Number.isSafeInteger(cacheUploadPartBytes) || cacheUploadPartBytes < 5 * 1024 * 1024) {
  throw new Error("CF_RUNNER_CACHE_UPLOAD_PART_BYTES must be at least 5 MiB");
}
if (configurationPath === undefined || configurationPath.length === 0) {
  throw new Error("CF_RUNNER_RESULTS_PROXY_CONFIGURATION_PATH is required");
}
if (upstreamPath === undefined || upstreamPath.length === 0) {
  throw new Error("CF_RUNNER_RESULTS_PROXY_UPSTREAM_PATH is required");
}

const uploads = new Map();

function isString(value) {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isNumber(value) {
  return Object.prototype.toString.call(value) === "[object Number]";
}

function isBodyMethod(method) {
  return method !== "GET" && method !== "HEAD";
}

function forwardedHeaders(headers) {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || hopByHopHeaders.has(name.toLowerCase())) {
      continue;
    }
    result.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return result;
}

function writeResponse(response, status, headers, body) {
  for (const [name, value] of headers.entries()) {
    if (!hopByHopHeaders.has(name.toLowerCase())) {
      response.setHeader(name, value);
    }
  }
  response.writeHead(status);
  if (body === null) {
    response.end();
    return;
  }
  Readable.fromWeb(body).pipe(response);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) {
      throw new Error("Cache control request is too large");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

let cachedCacheConfiguration;

async function cacheConfiguration() {
  if (cachedCacheConfiguration !== undefined) {
    return cachedCacheConfiguration;
  }
  const lines = (await readFile(configurationPath, "utf8")).split(/\r?\n/u);
  const endpoint = lines[0]?.trim();
  const authorization = lines[1]?.trim();
  if (endpoint === undefined || endpoint.length === 0 || authorization === undefined || authorization.length === 0) {
    throw new Error("Runner cache configuration is invalid");
  }
  cachedCacheConfiguration = { endpoint, authorization };
  return cachedCacheConfiguration;
}

async function cacheRequest(path, init = {}) {
  const configuration = await cacheConfiguration();
  const endpoint = new URL(`/v1/runner-cache-v2/${path}`, configuration.endpoint);
  const headers = new Headers(init.headers);
  headers.set("Authorization", configuration.authorization);
  return fetch(endpoint, { ...init, headers });
}

function json(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Length": Buffer.byteLength(text),
    "Content-Type": "application/json",
  });
  response.end(text);
}

async function forwardCacheControl(request, response) {
  const method = request.url.slice(cacheServicePrefix.length).split("?", 1)[0];
  const payload = await readJson(request);

  if (method === "GetCacheEntryDownloadURL") {
    const workerResponse = await cacheRequest("lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: payload.key,
        restoreKeys: payload.restoreKeys,
        version: payload.version,
      }),
    });
    json(response, workerResponse.status, await workerResponse.json());
    return;
  }

  if (method === "CreateCacheEntry") {
    const workerResponse = await cacheRequest("create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: payload.key, version: payload.version }),
    });
    const body = await workerResponse.json();
    if (!workerResponse.ok || body?.ok !== true || !isString(body?.session)) {
      json(response, workerResponse.status, body);
      return;
    }
    uploads.set(`${payload.key}\u0000${payload.version}`, { session: body.session, parts: new Map() });
    json(response, 200, {
      ok: true,
      signedUploadUrl: new URL(`${uploadPathPrefix}${encodeURIComponent(body.session)}`, proxyOrigin).toString(),
    });
    return;
  }

  if (method === "FinalizeCacheEntryUpload") {
    const upload = uploads.get(`${payload.key}\u0000${payload.version}`);
    if (upload === undefined) {
      json(response, 200, { ok: false, message: "Cloudflare cache upload session was not found" });
      return;
    }
    const workerResponse = await cacheRequest(`finalize?session=${encodeURIComponent(upload.session)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: payload.key, version: payload.version, sizeBytes: payload.sizeBytes }),
    });
    const body = await workerResponse.json();
    if (body?.ok === true) {
      uploads.delete(`${payload.key}\u0000${payload.version}`);
    }
    json(response, workerResponse.status, body);
    return;
  }

  json(response, 404, { msg: `Unsupported Cloudflare CacheService method: ${method}` });
}

function blockIdsFromXml(xml) {
  return [...xml.matchAll(/<Latest>([^<]+)<\/Latest>/gu)].map((match) => match[1]);
}

async function cacheResponseJson(workerResponse, operation) {
  const body = await workerResponse.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(
      `Cloudflare cache ${operation} returned ${workerResponse.status} with a non-JSON response: ${body.slice(0, 160)}`,
    );
  }
  if (!workerResponse.ok) {
    throw new Error(`Cloudflare cache ${operation} returned ${workerResponse.status}: ${body.slice(0, 160)}`);
  }
  return parsed;
}

function cacheBlockId(index) {
  return Buffer.from(`cloudflare-cache-${String(index).padStart(6, "0")}`).toString("base64");
}

async function uploadCacheArchiveInParts(request, session) {
  const parts = [];
  let pending = Buffer.alloc(0);

  const uploadPart = async (value) => {
    const blockId = cacheBlockId(parts.length);
    const workerResponse = await cacheRequest(
      `upload?session=${encodeURIComponent(session)}&block_id=${encodeURIComponent(blockId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": request.headers["content-type"] ?? "application/octet-stream" },
        body: value,
      },
    );
    const body = await cacheResponseJson(workerResponse, "archive part upload");
    if (!isString(body?.etag) || !isNumber(body?.partNumber)) {
      throw new Error("Cloudflare cache archive part upload returned an invalid response");
    }
    parts.push({ blockId, partNumber: body.partNumber, etag: body.etag });
  };

  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    pending = pending.length === 0 ? value : Buffer.concat([pending, value]);
    while (pending.length >= cacheUploadPartBytes) {
      // eslint-disable-next-line no-await-in-loop -- R2 parts must be uploaded in their stable archive order.
      await uploadPart(pending.subarray(0, cacheUploadPartBytes));
      pending = pending.subarray(cacheUploadPartBytes);
    }
  }
  if (pending.length > 0) {
    await uploadPart(pending);
  }
  if (parts.length === 0) {
    throw new Error("Cache archive upload body is empty");
  }

  const completed = await cacheRequest(`complete?session=${encodeURIComponent(session)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts }),
  });
  await cacheResponseJson(completed, "archive multipart completion");
}

async function forwardCacheUpload(request, response, url) {
  const session = decodeURIComponent(url.pathname.slice(uploadPathPrefix.length));
  if (session.length === 0) {
    json(response, 400, { error: "Cache upload session is required" });
    return;
  }
  const operation = url.searchParams.get("comp");
  if (request.method !== "PUT") {
    json(response, 405, { error: "Method not allowed" });
    return;
  }

  if (operation === "block") {
    const blockId = url.searchParams.get("blockid");
    if (blockId === null) {
      json(response, 400, { error: "Azure block ID is required" });
      return;
    }
    const workerResponse = await cacheRequest(
      `upload?session=${encodeURIComponent(session)}&block_id=${encodeURIComponent(blockId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": request.headers["content-type"] ?? "application/octet-stream" },
        body: request,
        duplex: "half",
      },
    );
    const body = await workerResponse.json();
    if (!workerResponse.ok) {
      json(response, workerResponse.status, body);
      return;
    }
    for (const upload of uploads.values()) {
      if (upload.session === session && isString(body?.etag) && isNumber(body?.partNumber)) {
        upload.parts.set(blockId, { partNumber: body.partNumber, etag: body.etag });
      }
    }
    response.writeHead(201, { ETag: '"cloudflare-cache-block"', "x-ms-request-id": "cloudflare-runner-cache" });
    response.end();
    return;
  }

  if (operation === "blocklist") {
    const blockIds = blockIdsFromXml(await readFileFromRequest(request));
    const upload = [...uploads.values()].find((candidate) => candidate.session === session);
    const parts = blockIds.map((blockId) => {
      const part = upload?.parts.get(blockId);
      return part === undefined ? { blockId } : { blockId, ...part };
    });
    const workerResponse = await cacheRequest(`complete?session=${encodeURIComponent(session)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts }),
    });
    if (!workerResponse.ok) {
      json(response, workerResponse.status, await workerResponse.json());
      return;
    }
    response.writeHead(201, { ETag: '"cloudflare-cache-upload"', "x-ms-request-id": "cloudflare-runner-cache" });
    response.end();
    return;
  }

  if (operation !== null) {
    json(response, 400, { error: `Unsupported Azure Blob operation: ${operation}` });
    return;
  }

  // Cloudflare's Worker request-body limit is below a typical actions/cache
  // archive. The Actions SDK uses one direct PUT, so split that stream into
  // R2 multipart blocks before it crosses the Worker boundary.
  await uploadCacheArchiveInParts(request, session);
  response.writeHead(201, { ETag: '"cloudflare-cache-upload"', "x-ms-request-id": "cloudflare-runner-cache" });
  response.end();
}

async function readFileFromRequest(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function forwardGitHubResults(request, response) {
  const upstream = (await readFile(upstreamPath, "utf8")).trim();
  if (upstream.length === 0) {
    json(response, 503, { error: "GitHub results endpoint is not configured" });
    return;
  }
  const upstreamUrl = new URL(request.url, upstream);
  const init = {
    method: request.method,
    headers: forwardedHeaders(request.headers),
    redirect: "manual",
  };
  if (isBodyMethod(request.method)) {
    init.body = request;
    init.duplex = "half";
  }
  const upstreamResponse = await fetch(upstreamUrl, init);
  writeResponse(response, upstreamResponse.status, upstreamResponse.headers, upstreamResponse.body);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", proxyOrigin);
    if (request.method === "GET" && url.pathname === "/healthz") {
      json(response, 200, { ok: true });
      return;
    }
    if (request.url?.startsWith(cacheServicePrefix) === true) {
      await forwardCacheControl(request, response);
      return;
    }
    if (url.pathname.startsWith(uploadPathPrefix)) {
      await forwardCacheUpload(request, response, url);
      return;
    }
    await forwardGitHubResults(request, response);
  } catch (error) {
    json(response, 502, { error: error instanceof Error ? error.message : "Runner results proxy failed" });
  }
});

// Load the short-lived cache capability before the Actions runner accepts a
// job, then remove its hand-off file. Workflow code cannot obtain a reusable
// Cloudflare or R2 credential from the container filesystem.
await cacheConfiguration();
await rm(configurationPath, { force: true });
server.listen(listenPort, listenHost);
