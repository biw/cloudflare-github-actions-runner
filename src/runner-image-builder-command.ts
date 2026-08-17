import { runnerImageSourceDigestCommand } from "./runner-image";

/**
 * Keep the daemonless builder alive so the Container exec API can launch the
 * one image-build command. This is an entrypoint override, not an HTTP server.
 */
export function runnerImageBuilderEntrypoint(): string[] {
  return ["/busybox/sh", "-c", "exec sleep 2147483647"];
}

export const runnerImageBuilderWorkspace = "/tmp/cloudflare-runner-workspace";
export const runnerImageBuilderExitStatusPath = `${runnerImageBuilderWorkspace}/build.exit`;
export const runnerImageBuilderLogPath = `${runnerImageBuilderWorkspace}/build.log`;
export const runnerImageBuilderBusyboxPath = `${runnerImageBuilderWorkspace}/busybox`;
export const runnerImageBuilderResultPath = `${runnerImageBuilderWorkspace}/build.result`;
export const runnerImageBuilderBuiltPath = `${runnerImageBuilderWorkspace}/build.built`;

function kanikoCommand(): string {
  return '/kaniko/executor --force --context "$workspace/source" --dockerfile "$workspace/source/docker/Dockerfile" --destination "$RUNNER_IMAGE_REFERENCE" --ignore-path "$workspace" --insecure-registry registry.cloudflare.com --insecure-registry index.docker.io --insecure-registry registry-1.docker.io --insecure-registry auth.docker.io --custom-platform linux/amd64 --cleanup --verbosity warn';
}

function shellSingleQuote(value: string): string {
  return value.replaceAll("'", "'\"'\"'");
}

/**
 * Stage and start a Kaniko build without Docker-in-Docker. When detached, the
 * initial exec returns after starting the build; the Durable Object polls the
 * retained status file instead of keeping a five-minute Container RPC open.
 */
export function runnerImageBuilderCommand(): string {
  const command = kanikoCommand();
  const buildAction = [
    "build_runner_image() {",
    'if /busybox/wget -q --spider "$RUNNER_IMAGE_REGISTRY_MANIFEST_URL/runner-$source_digest"; then',
    '  printf "%s" false > "$workspace/build.built"',
    "else",
    `  ${command} || return 13`,
    '  printf "%s" true > "$workspace/build.built"',
    "fi",
    "}",
    "build_runner_image",
  ].join("\n");
  const detachedBuildAction = shellSingleQuote(buildAction);
  return [
    "set -eu",
    ': "${RUNNER_IMAGE_SOURCE_URL:?missing source URL}"',
    ': "${RUNNER_IMAGE_REPOSITORY:?missing runner image repository}"',
    ': "${RUNNER_IMAGE_REGISTRY_MANIFEST_URL:?missing runner image registry manifest URL}"',
    `workspace="${runnerImageBuilderWorkspace}"`,
    'mkdir -p "$workspace/source"',
    // The Worker stages the GitHub archive into private R2 and routes this
    // host through a loopback entrypoint. No GitHub or R2 credential reaches
    // the Dockerfile process.
    'wget -qO "$workspace/source.tar.gz" "$RUNNER_IMAGE_SOURCE_URL" || exit 10',
    'tar -xzf "$workspace/source.tar.gz" -C "$workspace/source" --strip-components=1 || exit 11',
    // Keep a self-contained BusyBox binary under the ignored build context.
    // Kaniko's forced non-Docker mode replaces the root filesystem between
    // stages, but this binary survives long enough to report the exit status.
    '/busybox/cp /busybox/sh "$workspace/busybox"',
    '/busybox/chmod 0700 "$workspace/busybox"',
    `source_digest="$( ${runnerImageSourceDigestCommand("$workspace/source")} )" || exit 12`,
    'RUNNER_IMAGE_REFERENCE="$RUNNER_IMAGE_REPOSITORY:runner-$source_digest"',
    'printf "%s\\n%s\\n" "$source_digest" "$RUNNER_IMAGE_REFERENCE" > "$workspace/build.result"',
    // `setsid ... sh -c` starts a new shell. Export every value it needs;
    // otherwise detached production builds lose their destination reference.
    "export workspace source_digest RUNNER_IMAGE_REFERENCE",
    // The registry host is handled by this Container's outbound Worker proxy.
    // `--insecure-registry` makes Kaniko use HTTP only on encrypted
    // in-platform hops; Worker proxies upgrade them to verified HTTPS.
    // --force permits Kaniko to run in Cloudflare's Container runtime; it does
    // not grant extra privileges. The source and destination stay account
    // controlled. Public Docker Hub follows the same proxy pattern.
    'if [ "${RUNNER_IMAGE_BUILD_DETACHED:-}" = "1" ]; then',
    `  "$workspace/busybox" setsid "$workspace/busybox" sh -c '${detachedBuildAction}; status=$?; printf "%s" "$status" > "$workspace/build.exit"; exit "$status"' > "$workspace/build.log" 2>&1 < /dev/null &`,
    '  printf "%s" "$!" > "$workspace/build.pid"',
    "  exit 0",
    "fi",
    buildAction,
  ].join("\n");
}

export function runnerImageBuilderExitError(exitCode: number): string {
  const phase =
    {
      10: "download the configured GitHub source archive",
      11: "extract the configured GitHub source archive",
      12: "calculate the runner-image input digest",
      13: "build and push the runner image",
    }[exitCode] ?? "complete its remote image build process";
  return `Cloudflare image builder could not ${phase} (exit status ${exitCode})`;
}

/** Extract Cloudflare's non-sensitive process status from a command exit. */
export function runnerImageBuilderExitCode(exitCode: number): number {
  return Number.isSafeInteger(exitCode) && exitCode >= 0 ? exitCode : 1;
}
