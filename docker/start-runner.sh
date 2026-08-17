#!/bin/sh

set -eu

: "${ACTIONS_RUNNER_JIT_CONFIG:?ACTIONS_RUNNER_JIT_CONFIG must be supplied by the Worker}"

jit_config="$ACTIONS_RUNNER_JIT_CONFIG"
unset ACTIONS_RUNNER_JIT_CONFIG

invalid_runner_message=${CF_INVALID_RUNNER_MESSAGE:-}
unset CF_INVALID_RUNNER_MESSAGE
if [ -n "$invalid_runner_message" ]; then
  invalid_runner_diagnostic_path=/home/runner/.cf-runner/invalid-runner-diagnostic.txt
  mkdir --parents "$(dirname "$invalid_runner_diagnostic_path")"
  umask 077
  printf '%s\n' "$invalid_runner_message" > "$invalid_runner_diagnostic_path"
  export CF_INVALID_RUNNER_DIAGNOSTIC_PATH="$invalid_runner_diagnostic_path"
  export ACTIONS_RUNNER_HOOK_JOB_STARTED=/home/runner/job-started-hook.sh
fi
unset invalid_runner_message

resource_trace_endpoint=${CF_RESOURCE_TRACE_ENDPOINT:-}
resource_trace_authorization=${CF_RESOURCE_TRACE_AUTHORIZATION:-}
unset CF_RESOURCE_TRACE_ENDPOINT CF_RESOURCE_TRACE_AUTHORIZATION

runner_cache_endpoint=${CF_RUNNER_CACHE_ENDPOINT:-}
runner_cache_authorization=${CF_RUNNER_CACHE_AUTHORIZATION:-}
unset CF_RUNNER_CACHE_ENDPOINT CF_RUNNER_CACHE_AUTHORIZATION
runner_cache_configuration_path=/home/runner/.cf-runner/r2-cache
runner_cache_assignment_configuration_path=/home/runner/.cf-runner/r2-cache-assignment
results_proxy_upstream_path=/home/runner/.cf-runner/results-proxy-upstream
results_proxy_pid=

# Hand the runner-scoped cache capability to the loopback proxy. The proxy
# loads it before a workflow starts and removes this hand-off file immediately.
if [ -n "$runner_cache_endpoint" ] && [ -n "$runner_cache_authorization" ]; then
  mkdir --parents "$(dirname "$runner_cache_configuration_path")"
  umask 077
  printf '%s\n%s\n' "$runner_cache_endpoint" "$runner_cache_authorization" > "$runner_cache_configuration_path"
  # GitHub dispatches the job before its assignment webhook is guaranteed to
  # reach the Worker. The pre-job hook owns this second, short-lived copy and
  # removes it once the authoritative assignment is visible.
  printf '%s\n%s\n' "$runner_cache_endpoint" "$runner_cache_authorization" > "$runner_cache_assignment_configuration_path"
  export CF_RUNNER_CACHE_ASSIGNMENT_CONFIGURATION_PATH="$runner_cache_assignment_configuration_path"
  export ACTIONS_RUNNER_HOOK_JOB_STARTED=/home/runner/job-started-hook.sh
fi
unset runner_cache_endpoint runner_cache_authorization

# The patched Node action handler points ACTIONS_RESULTS_URL at this loopback
# proxy. CacheService calls are translated to R2; ArtifactService and every
# other results RPC are forwarded to GitHub with their original job token.
if [ -f "$runner_cache_configuration_path" ]; then
  export CF_RUNNER_RESULTS_PROXY_URL=http://127.0.0.1:8790
  export CF_RUNNER_RESULTS_PROXY_PORT=8790
  export CF_RUNNER_RESULTS_PROXY_CONFIGURATION_PATH="$runner_cache_configuration_path"
  export CF_RUNNER_RESULTS_PROXY_UPSTREAM_PATH="$results_proxy_upstream_path"
  runner-results-proxy &
  results_proxy_pid=$!
  proxy_attempt=1
  while [ "$proxy_attempt" -le 20 ]; do
    if curl --fail --silent http://127.0.0.1:8790/healthz >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "$results_proxy_pid" 2>/dev/null; then
      wait "$results_proxy_pid" || true
      echo "Cloudflare runner results proxy failed to start" >&2
      exit 1
    fi
    proxy_attempt=$((proxy_attempt + 1))
    sleep 0.1
  done
  if ! curl --fail --silent http://127.0.0.1:8790/healthz >/dev/null 2>&1; then
    echo "Cloudflare runner results proxy did not become ready" >&2
    exit 1
  fi
fi
unset runner_cache_configuration_path runner_cache_assignment_configuration_path results_proxy_upstream_path

# The workflow's shell must not inherit the ingestion capability. Supply it to
# the sampler once over stdin before starting the Actions runner instead.
if [ -n "$resource_trace_endpoint" ] && [ -n "$resource_trace_authorization" ]; then
  printf '%s\n%s\n' "$resource_trace_endpoint" "$resource_trace_authorization" | resource-trace &
else
  resource-trace &
fi
trace_pid=$!
unset resource_trace_endpoint resource_trace_authorization

stop_trace() {
  if kill -0 "$trace_pid" 2>/dev/null; then
    kill "$trace_pid" 2>/dev/null || true
  fi
  wait "$trace_pid" 2>/dev/null || true
}

stop_results_proxy() {
  if [ -n "$results_proxy_pid" ] && kill -0 "$results_proxy_pid" 2>/dev/null; then
    kill -TERM "$results_proxy_pid" 2>/dev/null || true
  fi
  if [ -n "$results_proxy_pid" ]; then
    wait "$results_proxy_pid" 2>/dev/null || true
  fi
}

stop_runner() {
  if [ -n "${runner_pid:-}" ]; then
    kill -TERM "$runner_pid" 2>/dev/null || true
  fi
  stop_results_proxy
  stop_trace
  exit 143
}

./run.sh --jitconfig "$jit_config" &
runner_pid=$!
trap stop_runner INT TERM

set +e
wait "$runner_pid"
runner_status=$?
set -e
stop_results_proxy
stop_trace

exit "$runner_status"
