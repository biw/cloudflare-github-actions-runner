#!/bin/sh

set -eu

read_number() {
  value=$(sed -n '1p' "$1" 2>/dev/null || true)
  case "$value" in
    "" | *[!0-9]*) printf '0' ;;
    *) printf '%s' "$value" ;;
  esac
}

format_mib() {
  awk -v bytes="$1" 'BEGIN { printf "%.2f MiB", bytes / 1048576 }'
}

format_gib() {
  awk -v bytes="$1" 'BEGIN { printf "%.2f GiB", bytes / 1073741824 }'
}

cpu_usage_usec=0
if [ -r /sys/fs/cgroup/cpu.stat ]; then
  cpu_usage_usec=$(awk '$1 == "usage_usec" { print $2 }' /sys/fs/cgroup/cpu.stat)
elif [ -r /sys/fs/cgroup/cpuacct/cpuacct.usage ]; then
  cpu_usage_nsec=$(read_number /sys/fs/cgroup/cpuacct/cpuacct.usage)
  cpu_usage_usec=$((cpu_usage_nsec / 1000))
fi

memory_current=0
memory_peak=0
memory_source="cgroup"
if [ -r /sys/fs/cgroup/memory.current ]; then
  memory_current=$(read_number /sys/fs/cgroup/memory.current)
  memory_peak=$(read_number /sys/fs/cgroup/memory.peak)
elif [ -r /sys/fs/cgroup/memory/memory.usage_in_bytes ]; then
  memory_current=$(read_number /sys/fs/cgroup/memory/memory.usage_in_bytes)
  memory_peak=$(read_number /sys/fs/cgroup/memory/memory.max_usage_in_bytes)
elif [ -r /proc/meminfo ]; then
  memory_source="procfs VM"
  memory_current=$(awk '
    $1 == "MemTotal:" { total = $2 }
    $1 == "MemAvailable:" { available = $2 }
    END { printf "%.0f", (total - available) * 1024 }
  ' /proc/meminfo)
fi

if [ "$memory_peak" -gt 0 ]; then
  memory_report="Memory (${memory_source}): $(format_mib "$memory_current") current, $(format_mib "$memory_peak") peak"
else
  memory_report="Memory (${memory_source}): $(format_mib "$memory_current") in use; cgroup peak unavailable"
fi

clock_ticks=$(getconf CLK_TCK)
system_uptime=$(awk '{ print $1 }' /proc/uptime)
init_start_ticks=$(awk '{ print $22 }' /proc/1/stat)
container_seconds=$(
  awk -v uptime="$system_uptime" -v started="$init_start_ticks" -v hz="$clock_ticks" \
    'BEGIN { elapsed = uptime - (started / hz); if (elapsed < 0) elapsed = 0; printf "%.3f", elapsed }'
)
cpu_seconds=$(awk -v usec="$cpu_usage_usec" 'BEGIN { printf "%.3f", usec / 1000000 }')

set -- $(df -B1 -P / | awk 'NR == 2 { print $2, $3, $4, $5 }')
disk_size=$1
disk_used=$2
disk_available=$3
disk_percent=$4

workspace_bytes=0
if [ -n "${GITHUB_WORKSPACE:-}" ] && [ -d "$GITHUB_WORKSPACE" ]; then
  workspace_bytes=$(du -sb "$GITHUB_WORKSPACE" 2>/dev/null | awk '{ print $1 }')
fi

memory_gib=${CF_CONTAINER_MEMORY_GIB:-1}
disk_gb=${CF_CONTAINER_DISK_GB:-4}
cpu_cost=$(awk -v usec="$cpu_usage_usec" 'BEGIN { printf "%.8f", (usec / 1000000) * 0.000020 }')
memory_cost=$(awk -v seconds="$container_seconds" -v gib="$memory_gib" \
  'BEGIN { printf "%.8f", seconds * gib * 0.0000025 }')
disk_cost=$(awk -v seconds="$container_seconds" -v gb="$disk_gb" \
  'BEGIN { printf "%.8f", seconds * gb * 0.00000007 }')
estimated_cost=$(awk -v cpu="$cpu_cost" -v memory="$memory_cost" -v disk="$disk_cost" \
  'BEGIN { printf "%.8f", cpu + memory + disk }')

report=$(printf '%s\n' \
  "Instance: ${CF_CONTAINER_INSTANCE_TYPE:-basic} (${memory_gib} GiB memory, ${disk_gb} GB disk)" \
  "Container elapsed time: ${container_seconds}s" \
  "Active CPU time: ${cpu_seconds} vCPU-s" \
  "$memory_report" \
  "Filesystem: $(format_gib "$disk_used") used of $(format_gib "$disk_size") (${disk_percent}), $(format_gib "$disk_available") available" \
  "Checked-out workspace: $(format_mib "$workspace_bytes")" \
  "Estimated resource cost so far: \$${estimated_cost}" \
  "  CPU \$${cpu_cost} + memory \$${memory_cost} + disk \$${disk_cost}" \
  "Estimate excludes plan allowances, egress, Workers, Durable Objects, logs, micro-VM overhead, and post-job teardown.")

printf '%s\n' "$report"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    printf '### Cloudflare Container usage estimate\n\n```text\n'
    printf '%s\n' "$report"
    printf '```\n'
  } >> "$GITHUB_STEP_SUMMARY"
fi
