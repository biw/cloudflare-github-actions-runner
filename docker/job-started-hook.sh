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
while [ "${assignment_max_attempts#0}" != "$assignment_max_attempts" ]; do
  assignment_max_attempts=${assignment_max_attempts#0}
done
if [ -z "$assignment_max_attempts" ]; then
  assignment_max_attempts=0
fi
if [ "$assignment_max_attempts" -lt 1 ]; then
  assignment_max_attempts=30
fi
assignment_poll_seconds=${CF_RUNNER_CACHE_ASSIGNMENT_POLL_SECONDS:-1}
case "$assignment_poll_seconds" in
  ''|*[!0-9.]*) assignment_poll_seconds=1 ;;
  *.*.*|.*) assignment_poll_seconds=1 ;;
esac

status=000
assignment_deadline_epoch=$(($(date +%s) + assignment_max_attempts))
attempt=1
while [ "$attempt" -le "$assignment_max_attempts" ]; do
  remaining_seconds=$((assignment_deadline_epoch - $(date +%s)))
  if [ "$remaining_seconds" -le 0 ]; then
    if [ "$attempt" -eq 1 ]; then
      remaining_seconds=1
    else
      break
    fi
  fi
  request_timeout_seconds=5
  if [ "$remaining_seconds" -lt "$request_timeout_seconds" ]; then
    request_timeout_seconds=$remaining_seconds
  fi
  status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time "$request_timeout_seconds" \
    --header "Authorization: $cache_authorization" "$assignment_endpoint" || true)
  if [ "$status" = '200' ]; then
    exit 0
  fi
  case "$status" in
    202) ;;
    # Transient conditions, not verdicts. The assignment record is written by
    # the Worker and read back through Cloudflare's edge, so a container can
    # poll before its authorization is visible and see 401. 000 is curl's
    # output for a connection failure. Keep polling inside the existing
    # bounded window instead of failing the job on the first sample.
    000|401|408|429|5??) ;;
    *)
      printf '%s\n' "::error title=Cloudflare runner cache assignment::The Worker returned HTTP $status while waiting for GitHub's runner assignment."
      exit 1
      ;;
  esac
  attempt=$((attempt + 1))
  remaining_seconds=$((assignment_deadline_epoch - $(date +%s)))
  if [ "$remaining_seconds" -le 0 ]; then
    break
  fi
  sleep_seconds=$(awk -v poll="$assignment_poll_seconds" -v remaining="$remaining_seconds" \
    'BEGIN { print (poll < remaining ? poll : remaining) }')
  sleep "$sleep_seconds"
done

# Still fail closed. The job must not run with a cache capability whose
# assignment the Worker never confirmed.
printf '%s\n' "::error title=Cloudflare runner cache assignment::GitHub's runner assignment was not observed within ${assignment_max_attempts} seconds (last Worker status: ${status})."
exit 1
