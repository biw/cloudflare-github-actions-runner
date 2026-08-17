import { describe, expect, it } from "vite-plus/test";

import {
  RUNNER_IMAGE_BUILDER_BOOTSTRAP_TAG,
  RUNNER_IMAGE_BUILDER_KANIKO_SOURCE_IMAGE,
  isRunnerImageSourcePush,
  publicRunnerImageBuildError,
  runnerImageBuilderBootstrapReference,
  runnerImageBuildCommand,
  runnerImageReference,
  runnerImageRepository,
  runnerImageSource,
  runnerImageSourceArchiveKey,
  runnerImageSourceDigestCommand,
} from "../src/runner-image";

const environment = {
  CLOUDFLARE_ACCOUNT_ID: "account-id",
  RUNNER_IMAGE_NAME: "cloudflare-github-actions-runner-runner",
  RUNNER_IMAGE_SOURCE_REPOSITORY: "biw/cloudflare-github-actions-runner",
  RUNNER_IMAGE_SOURCE_REF: "main",
};

describe("remote Cloudflare runner image configuration", () => {
  it("pins Kaniko's debug image so the remote command host has BusyBox tooling", () => {
    expect(RUNNER_IMAGE_BUILDER_KANIKO_SOURCE_IMAGE).toMatch(
      /^gcr\.io\/kaniko-project\/executor:debug@sha256:[a-f0-9]{64}$/u,
    );
  });

  it("names the account-private daemonless builder image deterministically", () => {
    expect(
      runnerImageBuilderBootstrapReference({
        CLOUDFLARE_ACCOUNT_ID: "account-id",
        RUNNER_IMAGE_BUILDER_IMAGE_NAME: "runner-image-builder",
      }),
    ).toBe(`registry.cloudflare.com/account-id/runner-image-builder:${RUNNER_IMAGE_BUILDER_BOOTSTRAP_TAG}`);
    expect(
      runnerImageBuilderBootstrapReference({
        CLOUDFLARE_ACCOUNT_ID: "account-id",
        RUNNER_IMAGE_BUILDER_IMAGE_NAME: "not valid",
      }),
    ).toBeUndefined();
  });

  it("uses an immutable content tag in the account-owned Cloudflare registry", () => {
    expect(runnerImageRepository(environment)).toBe(
      "registry.cloudflare.com/account-id/cloudflare-github-actions-runner-runner",
    );
    expect(runnerImageReference(environment, "0123456789abcdef01234567")).toBe(
      "registry.cloudflare.com/account-id/cloudflare-github-actions-runner-runner:runner-0123456789abcdef01234567",
    );
    expect(runnerImageReference(environment, "not-a-digest")).toBeUndefined();
  });

  it("uses a bounded private R2 key for each image-build workflow source", () => {
    expect(runnerImageSourceArchiveKey("setup-a1b2c3")).toBe("runner-image-source/setup-a1b2c3.tar.gz");
    expect(runnerImageSourceArchiveKey("../unsafe")).toBeUndefined();
  });

  it("accepts only pushes for the configured source repository and branch", () => {
    const source = runnerImageSource(environment);
    expect(
      isRunnerImageSourcePush(
        { repository: { owner: "BIW", repository: "cloudflare-github-actions-runner" }, ref: "refs/heads/main" },
        source,
      ),
    ).toBe(true);
    expect(
      isRunnerImageSourcePush({ repository: { owner: "biw", repository: "other" }, ref: "refs/heads/main" }, source),
    ).toBe(false);
    expect(
      isRunnerImageSourcePush(
        { repository: { owner: "biw", repository: "cloudflare-github-actions-runner" }, ref: "refs/heads/pull/2" },
        source,
      ),
    ).toBe(false);
  });

  it("hashes only runner-image inputs and keeps registry credentials out of the Docker build context", () => {
    const digest = runnerImageSourceDigestCommand();
    expect(digest).toContain("docker/Dockerfile");
    expect(digest).toContain("docker/start-runner.sh");
    expect(digest).not.toContain("README.md");

    const build = runnerImageBuildCommand();
    expect(build).toContain("docker build --quiet --network=host --platform linux/amd64");
    expect(build).toContain("docker push");
    expect(build).toContain("trap cleanup EXIT");
    expect(build).not.toContain("--build-arg");
  });

  it("only exposes safe operational and source-configuration failures from remote image builds", () => {
    expect(
      publicRunnerImageBuildError(
        new Error(
          "Could not download biw/cloudflare-github-actions-runner@main. Grant the GitHub App Contents: Read or make the source repository public.",
        ),
      ),
    ).toContain("Grant the GitHub App Contents: Read");
    expect(
      publicRunnerImageBuildError(new Error("Cloudflare image builder bootstrap lost its deployment-scoped claim")),
    ).toBe("Cloudflare image builder bootstrap lost its deployment-scoped claim");
    expect(publicRunnerImageBuildError(new Error("docker login password=secret"))).toBeUndefined();
  });
});
