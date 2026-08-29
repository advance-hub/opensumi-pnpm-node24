#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
linux_test_image=${WORKSPACE_AGENT_LINUX_TEST_IMAGE:-golang:1.23-bookworm}

docker run --rm \
  --volume "$repo_root:/workspace" \
  --workdir /workspace/go/workspace-agent \
  "$linux_test_image" \
  sh -c '
    set -eu
    if ! command -v gcc >/dev/null 2>&1; then
      if command -v apk >/dev/null 2>&1; then
        apk add --no-cache gcc musl-dev
      elif command -v apt-get >/dev/null 2>&1; then
        apt-get update
        DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gcc libc6-dev
      else
        echo "A C compiler is required for go test -race" >&2
        exit 1
      fi
    fi
    go version
    uname -a
    go test -race -count=1 -v ./...
    go vet ./...
    go build -buildvcs=false -trimpath -o /tmp/workspace-agent ./cmd/workspace-agent
    /tmp/workspace-agent --help
  '
