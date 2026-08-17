#!/bin/sh

# Samples the whole Container cgroup once a second. The runner process and all
# workflow steps share this cgroup, so this captures the resource use that
# Cloudflare bills for, rather than only the Actions runner process.
set -eu

trace_file=${CF_RESOURCE_TRACE_PATH:-/home/runner/.cf-runner/resource-trace.csv}
markers_file=${CF_RESOURCE_MARKERS_PATH:-/home/runner/.cf-runner/resource-markers.tsv}
trace_directory=$(dirname "$trace_file")
pending_file="${trace_file}.pending.tsv"

mkdir -p "$trace_directory"
umask 077

# start-runner supplies the endpoint and short-lived, runner-scoped capability
# through stdin, then removes both from the GitHub runner's environment.
trace_endpoint=
trace_authorization=
if IFS= read -r supplied_endpoint && IFS= read -r supplied_authorization; then
  case "$supplied_endpoint" in
    https://*)
      if [ -n "$supplied_authorization" ]; then
        trace_endpoint=$supplied_endpoint
        trace_authorization=$supplied_authorization
      fi
      ;;
  esac
fi

send_trace_batch() {
  batch_file=$1
  attempt=1
  while [ "$attempt" -le 3 ]; do
    if jq -Rsc '
      [ split("\n")[] | select(length > 0) | split("\t") |
        {
          timestamp: .[0],
          elapsedSeconds: (.[1] | tonumber),
          intervalSeconds: (.[2] | tonumber),
          phase: .[3],
          cpuTotalUsec: (.[4] | tonumber),
          cpuDeltaUsec: (.[5] | tonumber),
          cpuCoresAvg: (.[6] | tonumber),
          memoryCurrentBytes: (.[7] | tonumber),
          memoryPeakBytes: (.[8] | tonumber),
          rootDiskUsedBytes: (.[9] | tonumber),
          rootDiskDeltaBytes: (.[10] | tonumber)
        }
      ] | { samples: . }
    ' "$batch_file" | curl --fail --silent --show-error --max-time 10 \
      --request POST "$trace_endpoint" \
      --header "Authorization: Bearer $trace_authorization" \
      --header 'Content-Type: application/json' \
      --data-binary @- \
      --output /dev/null; then
      rm -f "$batch_file"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  echo "CF_RESOURCE_TRACE_UPLOAD_FAILED file=$batch_file" >&2
  return 1
}

flush_trace_samples() {
  if [ -z "$trace_endpoint" ] || [ ! -s "$pending_file" ]; then
    return
  fi
  batch_file="${pending_file}.$$.$(date +%s)"
  mv "$pending_file" "$batch_file"
  : > "$pending_file"
  send_trace_batch "$batch_file" &
}

read_number() {
  value=$(sed -n '1p' "$1" 2>/dev/null || true)
  case "$value" in
    "" | *[!0-9]*) printf '0' ;;
    *) printf '%s' "$value" ;;
  esac
}

cpu_usage_usec() {
  if [ -r /sys/fs/cgroup/cpu.stat ]; then
    awk '$1 == "usage_usec" { print $2; found = 1 } END { if (!found) print 0 }' /sys/fs/cgroup/cpu.stat
  elif [ -r /sys/fs/cgroup/cpuacct/cpuacct.usage ]; then
    value=$(read_number /sys/fs/cgroup/cpuacct/cpuacct.usage)
    printf '%s' "$((value / 1000))"
  else
    printf '0'
  fi
}

memory_current_bytes() {
  if [ -r /sys/fs/cgroup/memory.current ]; then
    read_number /sys/fs/cgroup/memory.current
  elif [ -r /sys/fs/cgroup/memory/memory.usage_in_bytes ]; then
    read_number /sys/fs/cgroup/memory/memory.usage_in_bytes
  else
    awk '
      $1 == "MemTotal:" { total = $2 }
      $1 == "MemAvailable:" { available = $2 }
      END { printf "%.0f", (total - available) * 1024 }
    ' /proc/meminfo
  fi
}

memory_peak_bytes() {
  if [ -r /sys/fs/cgroup/memory.peak ]; then
    read_number /sys/fs/cgroup/memory.peak
  elif [ -r /sys/fs/cgroup/memory/memory.max_usage_in_bytes ]; then
    read_number /sys/fs/cgroup/memory/memory.max_usage_in_bytes
  else
    memory_current_bytes
  fi
}

root_disk_used_bytes() {
  df -B1 -P / | awk 'NR == 2 { print $3 }'
}

phase() {
  if [ ! -r "$markers_file" ]; then
    printf '%s' 'runner startup'
    return
  fi
  marker=$(sed -n '$s/^[^	]*	//p' "$markers_file")
  if [ -n "$marker" ]; then
    printf '%s' "$marker"
  else
    printf '%s' 'runner startup'
  fi
}

timestamp() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

started_at=$(date +%s)
previous_at=$started_at
previous_cpu_usec=$(cpu_usage_usec)
baseline_disk_bytes=$(root_disk_used_bytes)

printf '%s\n' 'timestamp_utc,elapsed_seconds,interval_seconds,phase,cpu_total_usec,cpu_delta_usec,cpu_cores_avg,memory_current_bytes,memory_peak_bytes,root_disk_used_bytes,root_disk_delta_bytes' > "$trace_file"
printf '%s\t%s\n' "$(timestamp)" 'runner startup' > "$markers_file"
: > "$pending_file"
if [ -n "$trace_endpoint" ]; then
  echo 'CF_RESOURCE_TRACE D1 upload enabled'
fi

sample() {
  current_at=$(date +%s)
  interval_seconds=$((current_at - previous_at))
  if [ "$interval_seconds" -lt 1 ]; then
    interval_seconds=1
  fi
  elapsed_seconds=$((current_at - started_at))
  current_cpu_usec=$(cpu_usage_usec)
  cpu_delta_usec=$((current_cpu_usec - previous_cpu_usec))
  if [ "$cpu_delta_usec" -lt 0 ]; then
    cpu_delta_usec=0
  fi
  cpu_cores_avg=$(awk -v usec="$cpu_delta_usec" -v seconds="$interval_seconds" \
    'BEGIN { printf "%.6f", usec / 1000000 / seconds }')
  current_memory_bytes=$(memory_current_bytes)
  peak_memory_bytes=$(memory_peak_bytes)
  current_disk_bytes=$(root_disk_used_bytes)
  disk_delta_bytes=$((current_disk_bytes - baseline_disk_bytes))

  sample_timestamp=$(timestamp)
  sample=$(printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s' \
    "$sample_timestamp" \
    "$elapsed_seconds" \
    "$interval_seconds" \
    "$(phase)" \
    "$current_cpu_usec" \
    "$cpu_delta_usec" \
    "$cpu_cores_avg" \
    "$current_memory_bytes" \
    "$peak_memory_bytes" \
    "$current_disk_bytes" \
    "$disk_delta_bytes")
  printf '%s\n' "$sample" >> "$trace_file"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$sample_timestamp" \
    "$elapsed_seconds" \
    "$interval_seconds" \
    "$(phase)" \
    "$current_cpu_usec" \
    "$cpu_delta_usec" \
    "$cpu_cores_avg" \
    "$current_memory_bytes" \
    "$peak_memory_bytes" \
    "$current_disk_bytes" \
    "$disk_delta_bytes" >> "$pending_file"
  # Container stdout is retained by Cloudflare Observability. Keep the CSV
  # artifact too: it is the convenient, job-scoped record for analysis.
  printf 'CF_RESOURCE_SAMPLE %s\n' "$sample"

  previous_at=$current_at
  previous_cpu_usec=$current_cpu_usec

  # D1 writes are batched. Sampling stays per second, but a ten-sample upload
  # keeps Worker and D1 request overhead negligible for normal CI jobs.
  if [ $((elapsed_seconds % 10)) -eq 0 ]; then
    flush_trace_samples
  fi
}

# Include a final sample when the entrypoint stops the sampler after the JIT
# runner exits. That closes the otherwise up-to-one-second blind spot.
trap 'sample; flush_trace_samples; wait || true; exit 0' INT TERM

while :; do
  sample
  sleep 1
done
