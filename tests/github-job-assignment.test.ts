import { generateKeyPairSync } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { GitHubJobAssignmentClient } from "../src/github-job-assignment";

const target = { owner: "biw", repository: "runner-poc" };
const legacyEnvironment = {
  LEGACY_GITHUB_OWNER: target.owner,
  LEGACY_GITHUB_REPOSITORY: target.repository,
  GITHUB_RUNNER_TOKEN: "test-token",
};
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({
    type: "pkcs8",
    format: "pem",
  })
  .toString();
const appEnvironment = { GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: privateKey };

afterEach(() => vi.restoreAllMocks());

describe("GitHub assignment HTTP lookups", () => {
  it("mints one installation token for multiple candidate requests and uses GitHub's real job endpoint", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ token: "installation-token" }))
      .mockResolvedValueOnce(Response.json({ status: "queued", runner_id: 0, runner_name: null }))
      .mockResolvedValueOnce(Response.json({ status: "in_progress", runner_id: 42, runner_name: "cf-runner" }));
    const client = new GitHubJobAssignmentClient(appEnvironment, target, { fetch, now: () => 1_700_000_000_000 });
    const signal = new AbortController().signal;

    await expect(client.jobDetail("100", 42, signal)).resolves.toEqual({
      status: "queued",
      runner_id: 0,
      runner_name: null,
    });
    await expect(client.jobDetail("101", 42, signal)).resolves.toEqual({
      status: "in_progress",
      runner_id: 42,
      runner_name: "cf-runner",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.github.com/app/installations/42/access_tokens");
    expect(fetch.mock.calls[1]?.[0]).toBe("https://api.github.com/repos/biw/runner-poc/actions/jobs/100");
    expect(fetch.mock.calls[2]?.[0]).toBe("https://api.github.com/repos/biw/runner-poc/actions/jobs/101");
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: "Bearer installation-token" });
  });

  it("lists the latest workflow attempt with explicit pagination and parses runner identities", async () => {
    const page = {
      total_count: 101,
      jobs: [{ id: 100, status: "in_progress", runner_id: 42, runner_name: "cf-runner" }],
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(page));
    const client = new GitHubJobAssignmentClient(legacyEnvironment, target, { fetch, now: () => 1_700_000_000_000 });

    await expect(client.workflowJobs("12345", 2, null, new AbortController().signal)).resolves.toEqual(page);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://api.github.com/repos/biw/runner-poc/actions/runs/12345/jobs?filter=latest&per_page=100&page=2",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer test-token" }) }),
    );
  });

  it.each([
    ["HTTP failure", new Response("rate limited", { status: 429 })],
    ["invalid JSON", new Response("{unfinished")],
    ["invalid runner identity", Response.json({ status: "in_progress", runner_id: "42", runner_name: "cf-runner" })],
  ])("fails closed and records a %s", async (_scenario, response) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    const client = new GitHubJobAssignmentClient(legacyEnvironment, target, { fetch, now: () => 1_700_000_000_000 });

    await expect(client.jobDetail("100", null, new AbortController().signal)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  it("rejects a malformed workflow-jobs response", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ total_count: 1, jobs: [{}] }));
    const client = new GitHubJobAssignmentClient(legacyEnvironment, target, { fetch, now: () => 1_700_000_000_000 });

    await expect(client.workflowJobs("12345", 1, null, new AbortController().signal)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith("GitHub assignment lookup returned invalid workflow jobs", {
      runId: "12345",
      page: 1,
    });
  });

  it("aborts token issuance at the sweep deadline without starting a job request", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(init.signal.reason);
          } else {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          }
        }),
    );
    const client = new GitHubJobAssignmentClient(appEnvironment, target, { fetch, now: () => 1_700_000_000_000 });
    const lookup = client.jobDetail("100", 42, controller.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException("Sweep deadline exceeded", "TimeoutError"));

    await expect(lookup).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("does not perform network requests after the sweep deadline", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new GitHubJobAssignmentClient(legacyEnvironment, target, { fetch, now: () => 1_700_000_000_000 });
    const signal = AbortSignal.abort();
    await expect(client.jobDetail("100", null, signal)).resolves.toBeUndefined();
    await expect(client.workflowJobs("12345", 1, null, signal)).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
