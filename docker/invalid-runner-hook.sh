#!/bin/sh

set -eu

diagnostic_path=${CF_INVALID_RUNNER_DIAGNOSTIC_PATH:-}

printf '%s\n' '::error title=Invalid Cloudflare runner configuration::This job did not run because its runs-on label is invalid.'
printf '%s\n' 'Invalid Cloudflare runner configuration:'
if [ -n "$diagnostic_path" ] && [ -r "$diagnostic_path" ]; then
  sed 's/^/  /' "$diagnostic_path"
else
  printf '%s\n' '  The diagnostic details were unavailable. Correct the custom runs-on label and re-run the job.'
fi

# GitHub documents that a non-zero pre-job hook exit marks the assigned job as
# failed before any workflow steps execute.
exit 1
