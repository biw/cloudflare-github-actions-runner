import { NonRetryableError } from "cloudflare:workflows";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import {
  CloudflareContainersApiError,
  getContainerRolloutStatus,
  runnerImageBuilderApplicationHasLiveInstances,
  runnerImageBuilderApplicationRolloutsAreActive,
  rolloutRunnerApplicationImages,
  rolloutRunnerImageBuilderApplication,
  type RolloutRunnerApplicationImagesResult,
} from "./cloudflare-containers";
import type { WorkerEnvironment } from "./environment";
import { githubRepositoryArchiveAvailable } from "./github-app";
import {
  cleanupFailedRunnerImageBuild,
  runnerImageBuildFailureRequiresCleanup,
  runnerImageBuildTerminalErrorName,
  waitForRunnerImageBuilderApplicationIdle,
  waitForRunnerImageBuilderRollout,
  withFreshRunnerImageBuilder,
} from "./runner-image-build-orchestration";
import { runnerImageBuilderExitError } from "./runner-image-builder-command";
import {
  runnerImageBuilderProtocolVersion,
  type RunnerImageBuildResult,
  type RunnerImageBuildStatus,
} from "./runner-image-builder";
import { runnerImageBuilderBootstrapReference, runnerImageSource } from "./runner-image";

export interface RunnerImageBuildWorkflowParameters {
  reason: "setup" | "push";
  workflowId: string;
}

export type RunnerImageBuildStartParameters = Pick<RunnerImageBuildWorkflowParameters, "reason">;

export interface RunnerImageBuildWorkflowResult extends RunnerImageBuildResult {
  updatedApplications: string[];
  skippedApplications: string[];
}

const buildStep = {
  retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
  timeout: "30 minutes",
} as const;

const buildStatusStep = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "30 seconds",
} as const;

const maximumBuildStatusChecks = 174;
// A Workflow which arrives behind another source build must wait for it, then
// acquire a fresh slot and build the currently configured source. Bound this
// so a sustained push storm produces a useful, non-retryable diagnostic
// rather than consuming Workflow steps indefinitely.
const maximumBuildQueueRounds = 3;
const maximumRolloutAttempts = 72;
const maximumBuilderBootstrapRolloutChecks = 360;
// Container distribution can exceed the old six-minute in-step poll. Keep
// this 30-minute wait durable so the Workflow is not held open while idle.
const maximumPrivateBuilderRolloutChecks = 360;
const maximumPrivateBuilderStopChecks = 360;
// A healthy bootstrap owner can spend 30 minutes waiting for the deployment
// rollout, then run bounded copy and private-rollout steps with retries. Give
// joiners three hours (4,320 Workflow steps at two per 5-second interval),
// which covers that complete path without abandoning a healthy owner.
const maximumBuilderBootstrapReadyChecks = 2_160;

const sourceStep = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
  timeout: "3 minutes",
} as const;

const builderProtocolStep = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "3 minutes",
} as const;

const rolloutStep = {
  retries: { limit: 3, delay: "15 seconds", backoff: "exponential" },
  timeout: "3 minutes",
} as const;

const builderBootstrapStep = {
  retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
  timeout: "10 minutes",
} as const;

const builderRolloutStep = {
  retries: { limit: 3, delay: "15 seconds", backoff: "exponential" },
  timeout: "8 minutes",
} as const;

function rethrowConfigurationError(cause: unknown): never {
  if (
    cause instanceof CloudflareContainersApiError &&
    cause.status >= 400 &&
    cause.status < 500 &&
    cause.status !== 409
  ) {
    throw terminalRunnerImageBuildError(cause.message);
  }
  throw cause;
}

function terminalRunnerImageBuildError(message: string): NonRetryableError {
  return new NonRetryableError(message, runnerImageBuildTerminalErrorName);
}

export async function startRunnerImageBuild(
  env: WorkerEnvironment,
  id: string,
  params: RunnerImageBuildStartParameters,
): Promise<string> {
  try {
    const workflow = await env.RUNNER_IMAGE_BUILD_WORKFLOW.create({
      id,
      params: { ...params, workflowId: id },
      retention: { successRetention: "7 days", errorRetention: "7 days" },
    });
    return workflow.id;
  } catch {
    const existing = await env.RUNNER_IMAGE_BUILD_WORKFLOW.get(id);
    const status = await existing.status();
    if (status.status === "unknown") {
      throw new Error("Could not create the Cloudflare runner image build workflow");
    }
    return id;
  }
}

export class RunnerImageBuildWorkflow extends WorkflowEntrypoint<
  WorkerEnvironment,
  RunnerImageBuildWorkflowParameters
> {
  async run(
    event: Readonly<WorkflowEvent<RunnerImageBuildWorkflowParameters>>,
    step: WorkflowStep,
  ): Promise<RunnerImageBuildWorkflowResult> {
    const builderNamespace = this.env.RUNNER_IMAGE_BUILDER;
    const source = runnerImageSource(this.env);
    if (source === undefined) {
      throw terminalRunnerImageBuildError(
        "RUNNER_IMAGE_SOURCE_REPOSITORY and RUNNER_IMAGE_SOURCE_REF must identify a GitHub repository and branch",
      );
    }
    let ownsBuild = false;
    let ownsBootstrap = false;
    try {
      await step.do("initialize runner-image builder", builderProtocolStep, () =>
        withFreshRunnerImageBuilder(builderNamespace, async (builder) => {
          const protocolVersion = await builder.protocolVersion();
          if (protocolVersion !== runnerImageBuilderProtocolVersion) {
            throw new Error("Cloudflare runner-image builder is running an incompatible Worker version");
          }
        }),
      );
      await step.do("download runner-image source", sourceStep, async () => {
        if (!(await githubRepositoryArchiveAvailable(this.env, source.repository, source.ref))) {
          throw terminalRunnerImageBuildError(
            `Could not download ${source.repository.owner}/${source.repository.repository}@${source.ref}. Grant the GitHub App Contents: Read or make the source repository public.`,
          );
        }
      });
      let bootstrapCompleted = await step.do("initialize private daemonless image builder", builderProtocolStep, () =>
        withFreshRunnerImageBuilder(builderNamespace, (builder) => builder.bootstrapImageReady()),
      );
      if (!bootstrapCompleted) {
        const bootstrapReference = runnerImageBuilderBootstrapReference(this.env);
        if (bootstrapReference === undefined) {
          throw terminalRunnerImageBuildError(
            "RUNNER_IMAGE_BUILDER_IMAGE_NAME must identify a Container registry image",
          );
        }
        for (let attempt = 1; attempt <= maximumBuilderBootstrapReadyChecks && !bootstrapCompleted; attempt += 1) {
          // A joining Workflow retries the claim after every short delay. If
          // the prior owner failed and released it, this Workflow takes over
          // instead of waiting out the full bootstrap timeout.
          // eslint-disable-next-line no-await-in-loop -- this claim is deliberately serialized with the preceding readiness check.
          ownsBootstrap = await step.do(
            `claim private daemonless image builder bootstrap ${attempt}`,
            builderProtocolStep,
            () =>
              withFreshRunnerImageBuilder(builderNamespace, (builder) =>
                builder.beginBootstrap(event.payload.workflowId),
              ),
          );
          if (!ownsBootstrap) {
            // eslint-disable-next-line no-await-in-loop -- wait briefly before checking whether the current owner completed or released.
            await step.sleep(`wait for private daemonless builder bootstrap ${attempt}`, "5 seconds");
            // eslint-disable-next-line no-await-in-loop -- the owner records readiness after its platform rollout completes.
            bootstrapCompleted = await step.do(
              `check private daemonless builder bootstrap ${attempt}`,
              builderProtocolStep,
              () => withFreshRunnerImageBuilder(builderNamespace, (builder) => builder.bootstrapImageReady()),
            );
            continue;
          }

          // eslint-disable-next-line no-await-in-loop -- one owner advances the bootstrap phase before its external work.
          await withFreshRunnerImageBuilder(builderNamespace, (builder) =>
            builder.updateBuildProgress(event.payload.workflowId, "bootstrapping-builder"),
          );
          let deploymentRolloutFinished = false;
          for (let rolloutAttempt = 1; rolloutAttempt <= maximumBuilderBootstrapRolloutChecks; rolloutAttempt += 1) {
            // eslint-disable-next-line no-await-in-loop -- keep this long-lived ownership claim fresh while polling Cloudflare.
            await step.do(`renew private daemonless builder bootstrap ${rolloutAttempt}`, builderProtocolStep, () =>
              withFreshRunnerImageBuilder(builderNamespace, (builder) =>
                builder.renewBootstrap(event.payload.workflowId),
              ),
            );
            // eslint-disable-next-line no-await-in-loop -- wait for the exact builder application before replacing its image.
            const active = await step.do(
              `check existing daemonless builder rollout ${rolloutAttempt}`,
              builderRolloutStep,
              () => runnerImageBuilderApplicationRolloutsAreActive(this.env),
            );
            if (!active) {
              deploymentRolloutFinished = true;
              break;
            }
            // eslint-disable-next-line no-await-in-loop -- a deployment rollout must finish before the forced verified rollout begins.
            await step.sleep(`wait for existing daemonless builder rollout ${rolloutAttempt}`, "5 seconds");
          }
          if (!deploymentRolloutFinished) {
            throw terminalRunnerImageBuildError(
              "Cloudflare did not finish the builder deployment rollout before private bootstrap",
            );
          }
          // eslint-disable-next-line no-await-in-loop -- renew before every bounded external bootstrap operation.
          await step.do("renew private daemonless builder bootstrap before copy", builderProtocolStep, () =>
            withFreshRunnerImageBuilder(builderNamespace, (builder) =>
              builder.renewBootstrap(event.payload.workflowId),
            ),
          );
          // eslint-disable-next-line no-await-in-loop -- bootstrap is owned by this iteration's Durable Object claim.
          await step.do("copy private daemonless image builder", builderBootstrapStep, () =>
            withFreshRunnerImageBuilder(builderNamespace, (builder) => builder.bootstrap()),
          );
          // The bootstrap RPC can activate the temporary public-image
          // Container. Stop it explicitly, then use only the external
          // Containers API while waiting; another builder RPC here could make
          // the application active again immediately before its image rollout.
          // eslint-disable-next-line no-await-in-loop -- the current bootstrap owner must stop its one Container before changing that application's image.
          await step.do("stop temporary daemonless image builder", builderProtocolStep, () =>
            withFreshRunnerImageBuilder(builderNamespace, (builder) => builder.stopForBootstrapRollout()),
          );
          // eslint-disable-next-line no-await-in-loop -- this durable poll belongs to the current bootstrap owner's serialized image transition.
          await waitForRunnerImageBuilderApplicationIdle(
            (stopAttempt) =>
              step.do(`check temporary daemonless image builder stopped ${stopAttempt}`, builderRolloutStep, () =>
                runnerImageBuilderApplicationHasLiveInstances(this.env),
              ),
            (stopAttempt) =>
              step.sleep(`wait for temporary daemonless image builder to stop ${stopAttempt}`, "5 seconds"),
            maximumPrivateBuilderStopChecks,
          );
          // eslint-disable-next-line no-await-in-loop -- roll out the image before marking this bootstrap complete.
          const builderRollout = await step.do(
            "roll out private daemonless image builder",
            builderRolloutStep,
            async () => {
              await withFreshRunnerImageBuilder(builderNamespace, (builder) =>
                builder.updateBuildProgress(event.payload.workflowId, "rolling-out-builder"),
              );
              try {
                return await rolloutRunnerImageBuilderApplication(this.env, bootstrapReference, undefined, {
                  force: true,
                });
              } catch (error) {
                rethrowConfigurationError(error);
              }
            },
          );
          // eslint-disable-next-line no-await-in-loop -- each platform check and delay is persisted independently.
          await waitForRunnerImageBuilderRollout(
            builderRollout,
            (rolloutAttempt, applicationId, rolloutId) =>
              step.do(`check private daemonless image builder rollout ${rolloutAttempt}`, builderRolloutStep, () =>
                getContainerRolloutStatus(this.env, applicationId, rolloutId),
              ),
            (rolloutAttempt) =>
              step.sleep(`wait for private daemonless image builder rollout ${rolloutAttempt}`, "5 seconds"),
            maximumPrivateBuilderRolloutChecks,
          );
          // eslint-disable-next-line no-await-in-loop -- renew before every bounded external bootstrap operation.
          await step.do("renew private daemonless builder bootstrap before recording", builderProtocolStep, () =>
            withFreshRunnerImageBuilder(builderNamespace, (builder) =>
              builder.renewBootstrap(event.payload.workflowId),
            ),
          );
          // eslint-disable-next-line no-await-in-loop -- only the current owner records the ready state.
          await step.do("record private daemonless image builder", builderProtocolStep, () =>
            withFreshRunnerImageBuilder(builderNamespace, (builder) =>
              builder.markBootstrapImageReady(bootstrapReference, event.payload.workflowId),
            ),
          );
          ownsBootstrap = false;
          bootstrapCompleted = true;
        }
        if (!bootstrapCompleted) {
          throw terminalRunnerImageBuildError("Cloudflare did not finish the shared private builder bootstrap");
        }
      }
      let completed: RunnerImageBuildResult | undefined;
      for (let buildRound = 1; buildRound <= maximumBuildQueueRounds; buildRound += 1) {
        // eslint-disable-next-line no-await-in-loop -- each queued source is staged only after its predecessor completes.
        await withFreshRunnerImageBuilder(builderNamespace, (builder) =>
          builder.updateBuildProgress(event.payload.workflowId, "downloading-source"),
        );
        // A joining Workflow must wait for its predecessor, then stage its own source in a fresh slot.
        // eslint-disable-next-line no-await-in-loop -- the durable step serializes this exact queue position.
        ownsBuild = await step.do(`start runner image build in Cloudflare ${buildRound}`, buildStep, async () => {
          return await withFreshRunnerImageBuilder(builderNamespace, async (builder) => {
            const started = await builder.startBuild(event.payload.workflowId, source);
            return started.owner;
          });
        });
        let roundResult: RunnerImageBuildResult | undefined;
        let predecessorFailed = false;
        for (let attempt = 1; attempt <= maximumBuildStatusChecks; attempt += 1) {
          // eslint-disable-next-line no-await-in-loop -- each quick Container status probe follows a durable delay.
          const status = await step.do<RunnerImageBuildStatus>(
            `check runner image build ${buildRound}-${attempt}`,
            buildStatusStep,
            () =>
              withFreshRunnerImageBuilder(builderNamespace, async (builder) => {
                const checked = await builder.buildStatus();
                if (checked.kind === "completed") {
                  return {
                    kind: "completed",
                    result: {
                      sourceDigest: checked.result.sourceDigest,
                      imageReference: checked.result.imageReference,
                      built: checked.result.built,
                    },
                  };
                }
                if (checked.kind === "failed") {
                  return { kind: "failed", exitCode: checked.exitCode, diagnostic: checked.diagnostic };
                }
                return { kind: "running" };
              }),
          );
          if (status.kind === "completed") {
            roundResult = status.result;
            break;
          }
          if (status.kind === "failed") {
            if (!ownsBuild) {
              // A queued push may be the fix for a broken predecessor. Leave
              // the failed result to its owner and acquire a fresh build slot.
              predecessorFailed = true;
              break;
            }
            if (status.diagnostic !== undefined) {
              console.error("Cloudflare runner-image builder diagnostic:", status.diagnostic);
            }
            throw terminalRunnerImageBuildError(runnerImageBuilderExitError(status.exitCode));
          }
          // eslint-disable-next-line no-await-in-loop -- avoid holding one Container exec RPC over the full build.
          await step.sleep(`wait for runner image build ${buildRound}-${attempt}`, "10 seconds");
        }
        if (roundResult === undefined && !predecessorFailed) {
          throw terminalRunnerImageBuildError("Cloudflare runner image build did not complete within 29 minutes");
        }
        if (ownsBuild) {
          completed = roundResult;
          break;
        }
        // The predecessor's image is intentionally not rolled out by this
        // Workflow. Its own next round downloads and builds the newer source.
      }
      if (completed === undefined) {
        throw terminalRunnerImageBuildError(
          "Cloudflare runner image build queue did not drain after three source builds",
        );
      }
      let rollout: RolloutRunnerApplicationImagesResult = {
        updatedApplications: [],
        skippedApplications: [],
      };
      for (let attempt = 1; attempt <= maximumRolloutAttempts; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- each retry waits for exactly the active platform rollout it observed.
        rollout = await step.do(`roll runner applications to the new image ${attempt}`, rolloutStep, async () => {
          return await withFreshRunnerImageBuilder(builderNamespace, async (builder) => {
            // A Durable Object lease spans this external call. A newer source
            // build must wait rather than race an older rollout after a check.
            const lease = await builder.beginRollOut(event.payload.workflowId, completed.imageReference);
            if (!lease.acquired) {
              // Do not report a build as deployed when a newer Workflow took
              // ownership between its build finishing and this rollout. That
              // newer source may still fail, in which case silently succeeding
              // here would leave this successfully-built image unapplied.
              throw terminalRunnerImageBuildError(
                "Cloudflare runner image build lost its rollout lease to a newer source build",
              );
            }
            try {
              await builder.updateBuildProgress(event.payload.workflowId, "rolling-out");
              const result = await rolloutRunnerApplicationImages(this.env, completed.imageReference, undefined, {
                reissueMatchingImageRollouts: lease.reissueMatchingImageRollouts,
              });
              await builder.completeRollOutAttempt(event.payload.workflowId, completed.imageReference);
              // Keep the lease while busy applications are pending. The next
              // retry renews this same Workflow's lease, preventing a newer
              // source build from replacing it and abandoning these skipped
              // applications midway through their image rollout.
              if (result.skippedApplications.length === 0) {
                await builder.finishRollOut(event.payload.workflowId, completed.imageReference);
              }
              return result;
            } catch (error) {
              // Earlier applications may already be rolling. Preserve this
              // lease so the step retry joins that external state rather than a
              // newer build abandoning a partially applied image.
              rethrowConfigurationError(error);
            }
          });
        });
        if (rollout.skippedApplications.length === 0) {
          break;
        }
        // eslint-disable-next-line no-await-in-loop -- let platform rollouts or short-lived runners finish before retrying.
        await step.sleep(`wait for runner image rollout ${attempt}`, "10 seconds");
      }
      if (rollout.skippedApplications.length > 0) {
        throw terminalRunnerImageBuildError(
          `Cloudflare runner image rollout did not become idle for: ${rollout.skippedApplications.join(", ")}`,
        );
      }
      await withFreshRunnerImageBuilder(builderNamespace, (builder) =>
        builder.updateBuildProgress(event.payload.workflowId, "complete"),
      );
      return { ...completed, ...rollout };
    } catch (error) {
      if (runnerImageBuildFailureRequiresCleanup(error)) {
        await cleanupFailedRunnerImageBuild(builderNamespace, event.payload.workflowId, ownsBuild);
      }
      throw error;
    }
  }
}
