import { Container, ContainerProxy } from "@cloudflare/containers";
import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";

import { AccountRunnerScheduler } from "./account-runner-scheduler";
import { createContainerRegistryPushCredentials } from "./cloudflare-containers";
import {
  githubAppStatus,
  githubInstallationFromWebhook,
  githubRepositoryArchiveAvailable,
  githubTokenForRunner,
  githubWorkflowRunCacheScope,
  hasGitHubAppWebhookSecret,
  removeGitHubAppInstallations,
} from "./github-app";
import {
  githubRepositoryName,
  githubRunnerTokenFor,
  runnerPoolAcceptsGitHubRepository,
  type GitHubRepositoryTarget,
} from "./github-repository";
import { provisionRunner } from "./provision";
import { RunnerProvisioningWorkflow, startRunnerProvisioningWorkflows } from "./runner-provisioning-workflow";
import type { WorkerEnvironment } from "./environment";
import {
  cloudflareContainersTokenIdentity,
  hasValidSetupAuthorization,
  validateRunnerSetupTokens,
} from "./setup-validation";
import {
  assignResourceTraceRunner,
  parseResourceTracePayload,
  persistResourceTraceSamples,
  verifyResourceTraceAuthorization,
} from "./resource-traces";
import { handleRunnerCacheRequest, handleRunnerCacheV2Request, runnerCacheEnabled } from "./runner-cache";
import { RunnerCacheQuota } from "./runner-cache-quota";
import {
  hasValidOwnershipInspectionAuthorization,
  inspectRunnerResourceOwnership,
  recordRunnerResourceOwnership,
} from "./runner-resource-ownership";
import { runnerContainerFor } from "./runner-container-router";
import {
  RunnerEligibilityCheck,
  runnerEligibilityFor,
  type RunnerEligibilityInput,
  type RunnerEligibilityResult,
} from "./runner-eligibility";
import { RunnerImageBuilder } from "./runner-image-builder";
import {
  proxyDockerHubRequest,
  proxyPrivateRegistryRequest,
  privateRegistryRequestIsAllowed,
  RegistryAuthorizationCache,
} from "./runner-image-builder-registry-proxy";
import { RunnerImageBuildWorkflow, startRunnerImageBuild } from "./runner-image-build-workflow";
import {
  isRunnerImageSourcePush,
  publicRunnerImageBuildError,
  runnerImageRepository,
  runnerImageSource,
} from "./runner-image";
import { RUNNER_PROFILES } from "./runner-profiles";
import {
  classifyAuthorizedQueuedWebhook,
  classifyGitHubWebhookIntent,
  githubPushFromWebhook,
  githubRepositoryFromWebhook,
  hasValidGitHubSignature,
  type WebhookDecision,
} from "./webhook";

export {
  AccountRunnerScheduler,
  ContainerProxy,
  RunnerCacheQuota,
  RunnerEligibilityCheck,
  RunnerImageBuilder,
  RunnerImageBuildWorkflow,
  RunnerProvisioningWorkflow,
};

function registryAuthorization(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

const registryAuthorizationCache = new RegistryAuthorizationCache();

function pendingGitHubAppEnvironment(env: WorkerEnvironment) {
  return {
    GITHUB_APP_ID: env.PENDING_GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: env.PENDING_GITHUB_APP_PRIVATE_KEY,
    GITHUB_APP_WEBHOOK_SECRET: env.PENDING_GITHUB_APP_WEBHOOK_SECRET,
  };
}

/**
 * Direct Container egress entrypoint. This class must be declared in the main
 * Worker module so `ctx.exports` can create a loopback binding for it.
 */
export class RunnerImageBuilderRegistryProxy extends WorkerEntrypoint<WorkerEnvironment> {
  override async fetch(request: Request): Promise<Response> {
    try {
      const repository = runnerImageRepository(this.env);
      if (
        repository === undefined ||
        !privateRegistryRequestIsAllowed(request, repository.slice("registry.cloudflare.com/".length))
      ) {
        return new Response("Runner image registry access is not allowed", { status: 403 });
      }
      const authorization = await registryAuthorizationCache.get(async () => {
        const credentials = await createContainerRegistryPushCredentials(this.env);
        return registryAuthorization(credentials.username, credentials.password);
      });
      return proxyPrivateRegistryRequest(request, authorization);
    } catch (error) {
      console.error("Cloudflare runner-image registry proxy failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

interface RunnerImageBuilderSourceProxyProps {
  sourceArchiveKey: string;
}

/**
 * Serve precisely one Worker-staged source archive to the current build
 * Container. The key remains in loopback props, never in the Container
 * environment, and the R2 bucket itself has no public endpoint.
 */
export class RunnerImageBuilderSourceProxy extends WorkerEntrypoint<
  WorkerEnvironment,
  RunnerImageBuilderSourceProxyProps
> {
  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const source = await this.env.RUNNER_IMAGE_SOURCE.get(this.ctx.props.sourceArchiveKey);
    if (source === null) {
      return new Response("Runner image source is unavailable", { status: 404 });
    }
    return new Response(request.method === "HEAD" ? null : source.body, {
      headers: {
        "Content-Length": String(source.size),
        "Content-Type": source.httpMetadata?.contentType ?? "application/gzip",
      },
    });
  }
}

/** Forward Docker Hub pulls through verified Worker fetch without credentials. */
export class RunnerImageBuilderInternetProxy extends WorkerEntrypoint {
  override fetch(request: Request): Promise<Response> {
    return proxyDockerHubRequest(request);
  }
}

function json<const Body>(body: Body, status = 200): Response {
  return Response.json(body, { status });
}

abstract class GitHubActionsRunnerContainer extends Container<WorkerEnvironment> {
  sleepAfter = "1h";
  enableInternet = true;

  private runnerName(): string | undefined {
    return this.ctx.id.name;
  }

  override async onStart(): Promise<void> {
    const runnerName = this.runnerName();
    if (runnerName === undefined) {
      return;
    }
    await this.env.RUNNER_SCHEDULER.getByName(this.env.CLOUDFLARE_ACCOUNT_ID).runnerStarted(runnerName);
  }

  override async onStop({ exitCode, reason }: { exitCode: number; reason: string }): Promise<void> {
    const runnerName = this.runnerName();
    if (runnerName === undefined) {
      return;
    }
    const result = await this.env.RUNNER_SCHEDULER.getByName(this.env.CLOUDFLARE_ACCOUNT_ID).runnerStopped(runnerName, {
      exitCode,
      reason,
    });
    await startRunnerProvisioningWorkflows(this.env, result.admissions);
    console.log("Cloudflare GitHub Actions runner stopped", { runnerName, exitCode, reason });
  }

  override onError(cause: unknown): never {
    console.error("Cloudflare GitHub Actions runner failed to start", {
      runnerName: this.runnerName(),
      error: cause instanceof Error ? cause.message : String(cause),
    });
    throw cause;
  }
}

export class GitHubActionsRunnerLite extends GitHubActionsRunnerContainer {}
export class GitHubActionsRunnerBasic extends GitHubActionsRunnerContainer {}
export class GitHubActionsRunnerStandard1 extends GitHubActionsRunnerContainer {}
export class GitHubActionsRunnerStandard2 extends GitHubActionsRunnerContainer {}
export class GitHubActionsRunner extends GitHubActionsRunnerContainer {}
export class GitHubActionsRunnerStandard4 extends GitHubActionsRunnerContainer {}
export class GitHubActionsRunnerCustom extends GitHubActionsRunnerContainer {}
export class GitHubActionsRunnerCustom2 extends GitHubActionsRunnerContainer {}
export class GitHubActionsRunnerCustom3 extends GitHubActionsRunnerContainer {}
export class GitHubActionsRunnerCustom4 extends GitHubActionsRunnerContainer {}
export class GitHubActionsRunnerCustom5 extends GitHubActionsRunnerContainer {}
export class GitHubActionsRunnerCustom6 extends GitHubActionsRunnerContainer {}
export class GitHubActionsRunnerCustom7 extends GitHubActionsRunnerContainer {}
export class GitHubActionsRunnerCustom8 extends GitHubActionsRunnerContainer {}
export class GitHubActionsRunnerCustom9 extends GitHubActionsRunnerContainer {}
export class GitHubActionsRunnerCustom10 extends GitHubActionsRunnerContainer {}

/**
 * A small, isolated runner used only to turn an invalid `runs-on` request into
 * a failed GitHub Actions job. It deliberately does not participate in the
 * account scheduler: the pre-job hook exits before workflow code runs.
 */
export class GitHubActionsRunnerValidation extends Container<WorkerEnvironment> {
  sleepAfter = "5m";
  enableInternet = true;
}

type InvalidRunnerDecision = Extract<WebhookDecision, { kind: "invalid-runner" }>;

function invalidRunnerMessage(decision: InvalidRunnerDecision): string {
  return decision.errors.map((error) => `- ${error}`).join("\n");
}

export interface InvalidRunnerEligibilityDependencies {
  authorize(env: WorkerEnvironment, input: RunnerEligibilityInput): Promise<RunnerEligibilityResult>;
}

const invalidRunnerEligibilityDependencies: InvalidRunnerEligibilityDependencies = { authorize: runnerEligibilityFor };

export async function startInvalidRunner(
  env: WorkerEnvironment,
  target: GitHubRepositoryTarget,
  decision: InvalidRunnerDecision,
  dependencies: InvalidRunnerEligibilityDependencies = invalidRunnerEligibilityDependencies,
): Promise<"rejected" | "started"> {
  const eligibility = await dependencies.authorize(env, {
    jobId: decision.jobId,
    headSha: decision.headSha,
    target,
    installationId: decision.installationId ?? null,
  });
  if (eligibility.kind === "rejected") {
    console.log("Cloudflare invalid runner diagnostic rejected by repository eligibility", {
      jobId: decision.jobId,
      repository: githubRepositoryName(target),
      visibility: eligibility.visibility,
      checkReported: eligibility.checkReported,
    });
    return "rejected";
  }

  const token = await githubTokenForRunner(env, target, decision.installationId ?? null, (legacyTarget) =>
    githubRunnerTokenFor(env, legacyTarget),
  );
  if (token === undefined) {
    throw new Error(`No GitHub App installation token is available for ${target.owner}`);
  }

  const result = await provisionRunner(
    env,
    { ...target, token },
    runnerContainerFor(env, "validation", decision.runnerName),
    decision.runnerName,
    RUNNER_PROFILES.basic,
    {
      fetch: (input, init) => fetch(input, init),
      jitLabels: decision.labels,
      jobStartedHookMessage: invalidRunnerMessage(decision),
    },
  );
  if (result.kind !== "started" && result.kind !== "already-active") {
    throw new Error(`Could not start the invalid-runner diagnostic: ${result.kind}`);
  }
  console.log("Cloudflare invalid runner diagnostic accepted", {
    jobId: decision.jobId,
    runnerName: decision.runnerName,
    repository: githubRepositoryName(target),
    errors: decision.errors,
  });
  return "started";
}

export default {
  async fetch(request: Request, env: WorkerEnvironment, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/v1/resource-traces") {
      const claim = await verifyResourceTraceAuthorization(
        env.RESOURCE_TRACE_SIGNING_KEY,
        request.headers.get("Authorization"),
      );
      if (claim === undefined) {
        return json({ error: "Unauthorized" }, 401);
      }
      let payload: z.core.util.JSONType;
      try {
        const parsedPayload = z.json().safeParse(await request.json());
        if (!parsedPayload.success) {
          return json({ error: "Invalid resource trace payload" }, 400);
        }
        payload = parsedPayload.data;
      } catch {
        return json({ error: "Invalid resource trace payload" }, 400);
      }
      const trace = parseResourceTracePayload(payload);
      if (trace === undefined) {
        return json({ error: "Invalid resource trace payload" }, 400);
      }
      try {
        await persistResourceTraceSamples(env, claim, trace.samples);
      } catch (error) {
        console.error("Could not persist runner resource samples", {
          runnerName: claim.runnerName,
          jobId: claim.jobId,
          error: error instanceof Error ? error.message : String(error),
        });
        return json({ error: "Could not persist resource trace" }, 500);
      }
      return json({ accepted: trace.samples.length }, 202);
    }

    if (
      runnerCacheEnabled(env) &&
      (request.method === "GET" || request.method === "PUT") &&
      url.pathname === "/v1/runner-cache"
    ) {
      return handleRunnerCacheRequest(request, env, env.RUNNER_SCHEDULER.getByName(env.CLOUDFLARE_ACCOUNT_ID));
    }

    if (runnerCacheEnabled(env) && url.pathname.startsWith("/v1/runner-cache-v2/")) {
      return handleRunnerCacheV2Request(request, env, env.RUNNER_SCHEDULER.getByName(env.CLOUDFLARE_ACCOUNT_ID));
    }

    if (request.method === "POST" && url.pathname === "/v1/setup/validate") {
      if (!hasValidSetupAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }
      return json(await validateRunnerSetupTokens(env));
    }

    if (request.method === "GET" && url.pathname === "/v1/setup/cloudflare-token") {
      if (!hasValidSetupAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }
      return json({ token: await cloudflareContainersTokenIdentity(env) });
    }

    if (url.pathname === "/v1/setup/resource-ownership" && request.method === "POST") {
      if (!hasValidSetupAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }
      return json(await recordRunnerResourceOwnership(env));
    }

    if (url.pathname === "/v1/setup/resource-ownership" && request.method === "GET") {
      if (!hasValidOwnershipInspectionAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }
      return json({ resources: await inspectRunnerResourceOwnership(env) });
    }

    if (request.method === "GET" && url.pathname === "/v1/setup/github-app") {
      if (!hasValidSetupAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }
      return json(
        await githubAppStatus(url.searchParams.get("pending") === "1" ? pendingGitHubAppEnvironment(env) : env),
      );
    }

    if (request.method === "DELETE" && url.pathname === "/v1/setup/github-app/installations") {
      if (!hasValidSetupAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }
      return json({ removed: await removeGitHubAppInstallations(env) });
    }

    if (request.method === "GET" && url.pathname === "/v1/setup/runner-image/source") {
      if (!hasValidSetupAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }
      const source = runnerImageSource(env);
      if (source === undefined) {
        return json({ available: false, error: "Runner image source is not configured" }, 500);
      }
      const available = await githubRepositoryArchiveAvailable(env, source.repository, source.ref);
      return json({
        available,
        repository: `${source.repository.owner}/${source.repository.repository}`,
        ref: source.ref,
      });
    }

    if (request.method === "POST" && url.pathname === "/v1/setup/runner-image/build") {
      if (!hasValidSetupAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }
      const workflowId = await startRunnerImageBuild(env, `setup-${crypto.randomUUID()}`, { reason: "setup" });
      return json({ accepted: true, workflowId }, 202);
    }

    const imageBuildStatusMatch = url.pathname.match(/^\/v1\/setup\/runner-image\/build\/([A-Za-z0-9_-]+)$/u);
    if (request.method === "GET" && imageBuildStatusMatch !== null) {
      if (!hasValidSetupAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }
      const workflow = await env.RUNNER_IMAGE_BUILD_WORKFLOW.get(imageBuildStatusMatch[1]);
      const status = await workflow.status();
      const progress = await env.RUNNER_IMAGE_BUILDER.getByName("runner-image-builder").buildProgress(
        imageBuildStatusMatch[1],
      );
      const parsedErrorMessage = z.string().safeParse(status.error?.message);
      const buildError =
        status.status === "errored"
          ? publicRunnerImageBuildError(parsedErrorMessage.success ? new Error(parsedErrorMessage.data) : undefined)
          : undefined;
      return json({
        workflowId: imageBuildStatusMatch[1],
        status: status.status,
        progress,
        error: buildError,
        result: status.status === "complete" ? status.output : undefined,
      });
    }

    if (request.method === "GET" && url.pathname === "/v1/scheduler/status") {
      if (!hasValidSetupAuthorization(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }
      return json(await env.RUNNER_SCHEDULER.getByName(env.CLOUDFLARE_ACCOUNT_ID).status());
    }

    if (request.method !== "POST" || url.pathname !== "/webhooks/github") {
      return json({ error: "Not found" }, 404);
    }

    const rawBody = await request.arrayBuffer();
    const body = new TextDecoder().decode(rawBody);
    const target = githubRepositoryFromWebhook(body);
    const installationId = githubInstallationFromWebhook(body);
    const hasValidAppSignature =
      hasGitHubAppWebhookSecret(env) &&
      (await hasValidGitHubSignature(
        rawBody,
        request.headers.get("X-Hub-Signature-256"),
        env.GITHUB_APP_WEBHOOK_SECRET,
      ));
    if (hasValidAppSignature && request.headers.get("X-GitHub-Event") === "ping") {
      return json({ ok: true });
    }
    const githubEvent = request.headers.get("X-GitHub-Event");
    if (hasValidAppSignature && githubEvent === "push") {
      const push = githubPushFromWebhook(body);
      if (push !== undefined && isRunnerImageSourcePush(push, runnerImageSource(env))) {
        const workflowId = `push-${crypto.randomUUID()}`;
        ctx.waitUntil(
          startRunnerImageBuild(env, workflowId, { reason: "push" }).catch((error) => {
            console.error("Could not start the Cloudflare runner image build", {
              workflowId,
              repository: githubRepositoryName(push.repository),
              error: error instanceof Error ? error.message : String(error),
            });
          }),
        );
        return json({ accepted: true, imageBuild: "queued" }, 202);
      }
      return json({ accepted: false }, 202);
    }
    if (hasValidAppSignature && githubEvent !== "workflow_job") {
      return json({ accepted: false }, 202);
    }
    if (target === undefined) {
      return json({ error: "Invalid GitHub webhook payload" }, 400);
    }
    if (!hasValidAppSignature) {
      return json({ error: "Invalid webhook signature" }, 401);
    }
    if (!runnerPoolAcceptsGitHubRepository(env, target)) {
      const configuredOwner = env.GITHUB_RUNNER_OWNER;
      console.log("Cloudflare runner ignored a webhook outside its configured GitHub owner", {
        configuredOwner: env.GITHUB_RUNNER_OWNER,
        repository: githubRepositoryName(target),
      });
      return json(
        {
          accepted: false,
          reason:
            configuredOwner !== undefined && configuredOwner.trim() !== ""
              ? "github-owner-mismatch"
              : "github-owner-unconfigured",
        },
        202,
      );
    }
    if (hasValidAppSignature && installationId === undefined) {
      return json({ error: "GitHub App webhook has no installation ID" }, 400);
    }

    let decision = classifyGitHubWebhookIntent(
      request.headers.get("X-GitHub-Event"),
      body,
      githubRepositoryName(target),
    );
    if (decision.kind === "ping") {
      return json({ ok: true });
    }
    if (decision.kind === "ignored") {
      return json({ accepted: false }, 202);
    }
    if (decision.kind === "invalid") {
      return json({ error: "Invalid workflow_job payload" }, 400);
    }
    if (decision.kind === "cloudflare-job-queued") {
      const eligibility = await runnerEligibilityFor(env, {
        jobId: decision.jobId,
        headSha: decision.headSha,
        target,
        installationId: decision.installationId ?? null,
      });
      if (eligibility.kind === "rejected") {
        console.log("Cloudflare runner job rejected by repository eligibility", {
          jobId: decision.jobId,
          repository: githubRepositoryName(target),
          visibility: eligibility.visibility,
          checkReported: eligibility.checkReported,
        });
        return json(
          {
            accepted: false,
            reason: "repository-not-private",
            visibility: eligibility.visibility,
            checkReported: eligibility.checkReported,
          },
          202,
        );
      }
      decision = classifyAuthorizedQueuedWebhook(decision);
    }
    if (decision.kind === "invalid-runner") {
      ctx.waitUntil(
        startInvalidRunner(env, target, decision).catch((error) => {
          console.error("Could not start the Cloudflare invalid-runner diagnostic", {
            jobId: decision.jobId,
            repository: githubRepositoryName(target),
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      );
      return json({ accepted: true, validation: "queued" }, 202);
    }

    const scheduler = env.RUNNER_SCHEDULER.getByName(env.CLOUDFLARE_ACCOUNT_ID);
    try {
      if (decision.kind === "job-queued") {
        const cacheToken = runnerCacheEnabled(env)
          ? await githubTokenForRunner(env, target, installationId ?? null, (legacyRepositoryTarget) =>
              githubRunnerTokenFor(env, legacyRepositoryTarget),
            )
          : undefined;
        const cacheScope = runnerCacheEnabled(env)
          ? await githubWorkflowRunCacheScope(target, decision.workflowRunId, decision.defaultBranch, cacheToken)
          : undefined;
        const result = await scheduler.submit({
          jobId: decision.jobId,
          headSha: decision.headSha,
          runnerName: decision.runnerName,
          target,
          installationId,
          profile: decision.profile,
          workerOrigin: url.origin,
          cacheScope,
        });
        ctx.waitUntil(startRunnerProvisioningWorkflows(env, result.admissions));
        console.log("Cloudflare runner job accepted", {
          jobId: decision.jobId,
          runnerName: decision.runnerName,
          repository: `${target.owner}/${target.repository}`,
          queueReason: result.queueReason,
          cacheScope: cacheScope?.scope,
          cacheFallbackScope: cacheScope?.fallbackScope,
          cacheWriteAllowed: cacheScope?.writeAllowed,
        });
        return json(
          { accepted: result.accepted, queued: result.admissions.length === 0, queueReason: result.queueReason },
          202,
        );
      }

      if (decision.kind === "job-started") {
        const result = await scheduler.workflowJobStarted({
          jobId: decision.jobId,
          runnerName: decision.runnerName,
          runnerId: decision.runnerId,
          target,
          profile: decision.profile,
        });
        if (result.accepted) {
          await assignResourceTraceRunner(env, {
            runnerName: decision.runnerName,
            jobId: decision.jobId,
            repository: `${target.owner}/${target.repository}`,
          });
        }
        ctx.waitUntil(startRunnerProvisioningWorkflows(env, result.admissions));
        console.log("Cloudflare runner GitHub assignment observed", {
          jobId: decision.jobId,
          runnerName: decision.runnerName,
          accepted: result.accepted,
        });
        return json({ accepted: result.accepted, queued: result.admissions.length !== 0 }, 202);
      }

      const result = await scheduler.workflowJobCompleted(decision.jobId);
      ctx.waitUntil(startRunnerProvisioningWorkflows(env, result.admissions));
      console.log("Cloudflare runner job completed", { jobId: decision.jobId });
      return json({ accepted: result.accepted }, 202);
    } catch (error) {
      console.error("Cloudflare runner scheduler error", {
        error: error instanceof Error ? error.message : String(error),
      });
      return json({ error: "Runner scheduling failed" }, 500);
    }
  },
} satisfies ExportedHandler<WorkerEnvironment>;
