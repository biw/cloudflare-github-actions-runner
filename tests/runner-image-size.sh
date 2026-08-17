#!/usr/bin/env bash

set -euo pipefail

readonly MAX_IMAGE_BYTES=1500000000
readonly IMAGE_TAG="cloudflare-github-actions-runner:size-test"
readonly REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cleanup() {
  docker image rm --force "${IMAGE_TAG}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build \
  --no-cache \
  --platform linux/amd64 \
  --pull \
  --file "${REPOSITORY_ROOT}/docker/Dockerfile" \
  --tag "${IMAGE_TAG}" \
  "${REPOSITORY_ROOT}"

image_size_bytes="$(docker image inspect "${IMAGE_TAG}" --format '{{.Size}}')"

if [[ ! "${image_size_bytes}" =~ ^[0-9]+$ ]]; then
  echo "Docker returned an invalid runner image size: ${image_size_bytes}" >&2
  exit 1
fi

echo "Runner image size: ${image_size_bytes} bytes (limit: ${MAX_IMAGE_BYTES} bytes)"

if ((image_size_bytes >= MAX_IMAGE_BYTES)); then
  echo "Runner image must be smaller than 1.5 GB." >&2
  exit 1
fi
