#!/bin/sh

set -eu

diagnostic_path=${CF_INVALID_RUNNER_DIAGNOSTIC_PATH:-}
if [ -n "$diagnostic_path" ]; then
  exec /home/runner/invalid-runner-hook.sh
fi

assignment_configuration_path=${CF_RUNNER_CACHE_ASSIGNMENT_CONFIGURATION_PATH:-}
unset CF_RUNNER_CACHE_ASSIGNMENT_CONFIGURATION_PATH
if [ -z "$assignment_configuration_path" ] || [ ! -r "$assignment_configuration_path" ]; then
  exit 0
fi

cache_endpoint=$(sed -n '1p' "$assignment_configuration_path")
cache_authorization=$(sed -n '2p' "$assignment_configuration_path")
rm -f "$assignment_configuration_path"

if [ -z "$cache_endpoint" ] || [ -z "$cache_authorization" ]; then
  printf '%s\n' '::error title=Cloudflare runner cache assignment::The runner cache capability was invalid before this job started.'
  exit 1
fi

assignment_endpoint="${cache_endpoint%/v1/runner-cache}/v1/runner-cache-v2/assignment"
assignment_max_attempts=${CF_RUNNER_CACHE_ASSIGNMENT_MAX_ATTEMPTS:-30}
case "$assignment_max_attempts" in
  ''|*[!0-9]*) assignment_max_attempts=30 ;;
esac
if [ "$assignment_max_attempts" -lt 1 ]; then
  assignment_max_attempts=30
fi
assignment_poll_seconds=${CF_RUNNER_CACHE_ASSIGNMENT_POLL_SECONDS:-1}
case "$assignment_poll_seconds" in
  ''|*[!0-9.]*) assignment_poll_seconds=1 ;;
  *.*.*|.*) assignment_poll_seconds=1 ;;
esac

attempt=1
while [ "$attempt" -le "$assignment_max_attempts" ]; do
  status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 \
    --header "Authorization: $cache_authorization" "$assignment_endpoint" || true)
  if [ "$status" = '200' ]; then
    exit 0
  fi
  if [ "$status" != '202' ]; then
    printf '%s\n' "::error title=Cloudflare runner cache assignment::The Worker returned HTTP $status while waiting for GitHub's runner assignment."
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep "$assignment_poll_seconds"
done

printf '%s\n' "::error title=Cloudflare runner cache assignment::GitHub's runner assignment was not observed within ${assignment_max_attempts} seconds."
exit 1
