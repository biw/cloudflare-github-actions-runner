#!/bin/sh

set -eu

trace_file=${CF_RESOURCE_TRACE_PATH:-/home/runner/.cf-runner/resource-trace.csv}

summary() {
  if [ ! -f "$trace_file" ]; then
    echo "Resource trace does not exist yet: $trace_file" >&2
    exit 1
  fi

  temporary_summary=$(mktemp)
  trap 'rm -f "$temporary_summary"' EXIT HUP INT TERM
  awk -F, '
    NR == 1 { next }
    {
      phase = $4
      samples[phase] += 1
      cpu_usec[phase] += $6
      if (($7 + 0) > peak_cpu[phase]) peak_cpu[phase] = $7 + 0
      if (($8 + 0) > peak_memory[phase]) peak_memory[phase] = $8 + 0
      if (($11 + 0) > peak_disk_delta[phase]) peak_disk_delta[phase] = $11 + 0
    }
    END {
      for (phase in samples) {
        printf "%s\t%d\t%.3f\t%.3f\t%.1f\t%.1f\n", \
          phase, samples[phase], cpu_usec[phase] / 1000000, peak_cpu[phase], \
          peak_memory[phase] / 1048576, peak_disk_delta[phase] / 1048576
      }
    }
  ' "$trace_file" | sort -t "$(printf '\t')" -k3,3nr > "$temporary_summary"

  printf '%s\n\n' '### Cloudflare resource trace (one-second samples)'
  printf '%s\n' '| Phase | Samples | CPU (vCPU-s) | Peak CPU (cores) | Peak RAM (MiB) | Peak job disk delta (MiB) |'
  printf '%s\n' '| --- | ---: | ---: | ---: | ---: | ---: |'
  while IFS="$(printf '\t')" read -r phase samples cpu peak_cpu peak_memory peak_disk_delta; do
    printf '| %s | %s | %s | %s | %s | %s |\n' \
      "$phase" "$samples" "$cpu" "$peak_cpu" "$peak_memory" "$peak_disk_delta"
  done < "$temporary_summary"
  printf '\nRaw one-second samples are in the `cloudflare-resource-trace` artifact. Disk delta is relative to runner startup.\n'
}

if [ "${1:-}" = 'path' ] && [ "$#" -eq 1 ]; then
  printf '%s\n' "$trace_file"
  exit 0
fi

if [ "${1:-}" = 'snapshot' ] && [ "$#" -eq 2 ]; then
  destination=$2
  if [ ! -f "$trace_file" ]; then
    echo "Resource trace does not exist yet: $trace_file" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$destination")"
  temporary_destination="${destination}.tmp.$$"
  cp "$trace_file" "$temporary_destination"
  mv "$temporary_destination" "$destination"
  exit 0
fi

if [ "${1:-}" = 'summary' ] && [ "$#" -eq 1 ]; then
  summary
  exit 0
fi

echo 'Usage: cf-resource-trace path | cf-resource-trace snapshot <destination> | cf-resource-trace summary' >&2
exit 64
