#!/bin/sh

set -eu

if [ "$#" -eq 0 ]; then
  echo 'Usage: cf-resource-mark <phase name>' >&2
  exit 64
fi

markers_file=${CF_RESOURCE_MARKERS_PATH:-/home/runner/.cf-runner/resource-markers.tsv}
mkdir -p "$(dirname "$markers_file")"

# Marker names become part of a TSV file and the GitHub Actions artifact.
# Keep them readable and prevent untrusted line or field breaks.
phase=$(printf '%s' "$*" | tr '\r\n\t,' '    ' | tr -s ' ')
if [ -z "$phase" ]; then
  phase='unnamed phase'
fi

printf '%s\t%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$phase" >> "$markers_file"
