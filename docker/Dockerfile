FROM ubuntu:24.04 AS runner-builder

ARG RUNNER_VERSION=2.336.0
ARG RUNNER_SOURCE_REVISION=98aabcd429c4e8402406c56ce2d26387fed3b9ce

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    ca-certificates \
    curl \
    git \
    libicu74 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/actions-runner-source
RUN git clone --depth 1 --branch "v${RUNNER_VERSION}" https://github.com/actions/runner.git . \
  && test "$(git rev-parse HEAD)" = "${RUNNER_SOURCE_REVISION}"
COPY docker/actions-runner-results-proxy.patch /tmp/actions-runner-results-proxy.patch
RUN git apply /tmp/actions-runner-results-proxy.patch \
  && cd src \
  && ./dev.sh layout Release

# GitHub.com now executes JavaScript actions with Node 24. This runner cannot
# execute Docker container actions, so the Node copies used only inside Alpine
# container steps are unreachable. Prune them in the builder stage so they are
# absent from the final image layer instead of hidden behind whiteouts.
RUN test -x /opt/actions-runner-source/_layout/externals/node24/bin/node \
  && rm -rf \
    /opt/actions-runner-source/_layout/externals/node20 \
    /opt/actions-runner-source/_layout/externals/node20_alpine \
    /opt/actions-runner-source/_layout/externals/node24_alpine

FROM ubuntu:24.04

ARG RUNNER_VERSION=2.336.0
ARG NODE_VERSION=22.23.2
ARG NODE_SHA256=d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307

ENV DEBIAN_FRONTEND=noninteractive \
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true \
  RUNNER_TOOL_CACHE=/opt/hostedtoolcache \
  AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache \
  CF_RESOURCE_TRACE_PATH=/home/runner/.cf-runner/resource-trace.csv \
  CF_RESOURCE_MARKERS_PATH=/home/runner/.cf-runner/resource-markers.tsv \
  ImageOS=cloudflare-ubuntu-24.04 \
  ImageVersion=cloudflare-runner-${RUNNER_VERSION}

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    build-essential \
    bzip2 \
    ca-certificates \
    cmake \
    curl \
    git \
    git-lfs \
    jq \
    ninja-build \
    openssh-client \
    pkg-config \
    python3 \
    rsync \
    tini \
    unzip \
    wget \
    xz-utils \
    zip \
    zstd \
  && useradd --create-home --shell /bin/bash runner \
  && mkdir --parents /home/runner/actions-runner \
  && mkdir --parents "${RUNNER_TOOL_CACHE}/node/${NODE_VERSION}" \
  && curl --fail --location --retry 3 \
    --output /tmp/node.tar.xz \
    "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
  && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum --check --status \
  && tar --extract --xz --file /tmp/node.tar.xz --directory /usr/local --strip-components=1 \
  && rm /tmp/node.tar.xz \
  && ln --symbolic /usr/local "${RUNNER_TOOL_CACHE}/node/${NODE_VERSION}/x64" \
  && touch "${RUNNER_TOOL_CACHE}/node/${NODE_VERSION}/x64.complete" \
  && corepack enable \
  && rm -rf /var/lib/apt/lists/*

COPY --from=runner-builder --chown=runner:runner /opt/actions-runner-source/_layout/ /home/runner/actions-runner/

RUN /home/runner/actions-runner/bin/installdependencies.sh \
  && rm -rf /var/lib/apt/lists/* \
  && chown runner:runner /home/runner/actions-runner \
  && chown --recursive runner:runner "${RUNNER_TOOL_CACHE}"

COPY --chown=runner:runner docker/start-runner.sh /home/runner/start-runner.sh
COPY --chown=runner:runner docker/invalid-runner-hook.sh /home/runner/invalid-runner-hook.sh
COPY --chown=runner:runner docker/job-started-hook.sh /home/runner/job-started-hook.sh
COPY docker/report-container-usage.sh /usr/local/bin/report-container-usage
COPY --chown=runner:runner docker/resource-trace.sh /usr/local/bin/resource-trace
COPY --chown=runner:runner docker/cf-resource-mark.sh /usr/local/bin/cf-resource-mark
COPY --chown=runner:runner docker/cf-resource-trace.sh /usr/local/bin/cf-resource-trace
COPY --chown=runner:runner docker/runner-results-proxy.mjs /usr/local/bin/runner-results-proxy
RUN chmod 0755 \
  /home/runner/start-runner.sh \
  /home/runner/invalid-runner-hook.sh \
  /home/runner/job-started-hook.sh \
  /usr/local/bin/report-container-usage \
  /usr/local/bin/resource-trace \
  /usr/local/bin/cf-resource-mark \
  /usr/local/bin/cf-resource-trace \
  /usr/local/bin/runner-results-proxy

USER runner
WORKDIR /home/runner/actions-runner

ENTRYPOINT ["/usr/bin/tini", "--", "/home/runner/start-runner.sh"]
