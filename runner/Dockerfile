# The build stage stays on the native builder architecture and cross-compiles,
# because emulating a Go toolchain under QEMU costs minutes per target.
FROM --platform=$BUILDPLATFORM golang:1.26 AS build
ARG TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH="${TARGETARCH}" \
    go build -trimpath -ldflags='-s -w' -o /dsh-yawn-runner ./cmd/dsh-yawn-runner

FROM debian:trixie-slim
ARG TARGETARCH
ARG JJ_VERSION=0.44.0
ARG JJ_SHA256_amd64=0a07bab4641a55fd2bc2fd1563ba3a3f9a577584086ad74086a1c5b69b3ffce9
ARG JJ_SHA256_arm64=60d42fa2a9abaa445eff10cd2087458562aaad5a54b90309e5a3787ecc985ff2
ARG MISE_VERSION=2026.8.16
ARG MISE_SHA256_amd64=1445289f35e1a5a7216e1ffee5b34c5b9bd46793224e7e6c335503de9d9df0b2
ARG MISE_SHA256_arm64=21a03117d27028b1b4602bc83d9aefdccd55325ac3da45f7e28c9320627dcdc6
# Keep equal to mise.toml, which explains the 24.19.0 pin (nodejs/node#65677).
ARG NODE_VERSION=24.19.0
# ripgrep backs the session's `glob` and `grep` search tools: the stock row
# names the host's packaged binary, and the control plane's subprocess seam resolves
# `rg` on the runner's PATH in its place.
ARG RIPGREP_VERSION=15.2.0
ARG RIPGREP_SHA256_amd64=33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c
ARG RIPGREP_SHA256_arm64=800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915
ARG UV_VERSION=0.12.9
ARG UV_SHA256_amd64=aa4b1f8770910f7c7c543c7acc980e4270e52e70750c996acef813ea1c7c2912
ARG UV_SHA256_arm64=7eb9bf48516448c9db6a9e436d8e747ac9c8a9cac74717160a29918249b080a6
ARG YQ_VERSION=4.53.6
ARG YQ_SHA256_amd64=c5f056448f973ae7d39b5401949648a78f2dc1947d6a8eb65be60d5c504b9385
ARG YQ_SHA256_arm64=88a1016bc1d657375a35864e4f44b6f333df8ff97b559f51bba0adcb2169df09
# Debian trixie ships gh 2.46.0, which predates `--attach` (added in 2.99.0),
# the flag that uploads local images and videos into issues, pull requests, and
# comments. Install the pinned release instead of the apt package, and keep the
# pin equal to mise.toml, whose gh `.agents/setup` puts ahead of this copy.
ARG GH_VERSION=2.102.0
ARG GH_SHA256_amd64=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386
ARG GH_SHA256_arm64=7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484
# agent-browser backs the `using-agent-browser` skill. Only the CLI is in this
# image: Chrome, the libraries it links against, and a font are larger than
# everything else here, and `install-browser` adds them on demand. The CLI is
# installed outside $HOME and /workspace (a session mounts its workspace volume
# over /workspace) and linked onto PATH.
ARG AGENT_BROWSER_VERSION=0.37.1
ARG AGENT_BROWSER_INSTALL_DIR=/opt/agent-browser
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) jj_arch=x86_64-unknown-linux-musl;  mise_arch=linux-x64-musl;   jj_sha="${JJ_SHA256_amd64}"; mise_sha="${MISE_SHA256_amd64}"; rg_arch=x86_64-unknown-linux-musl;  rg_sha="${RIPGREP_SHA256_amd64}"; uv_arch=x86_64-unknown-linux-musl;  uv_sha="${UV_SHA256_amd64}"; yq_sha="${YQ_SHA256_amd64}"; gh_sha="${GH_SHA256_amd64}" ;; \
      arm64) jj_arch=aarch64-unknown-linux-musl; mise_arch=linux-arm64-musl; jj_sha="${JJ_SHA256_arm64}"; mise_sha="${MISE_SHA256_arm64}"; rg_arch=aarch64-unknown-linux-musl; rg_sha="${RIPGREP_SHA256_arm64}"; uv_arch=aarch64-unknown-linux-musl; uv_sha="${UV_SHA256_arm64}"; yq_sha="${YQ_SHA256_arm64}"; gh_sha="${GH_SHA256_arm64}" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash build-essential ca-certificates curl file git jq \
      openssh-client patch pkg-config procps \
      python3 python3-venv python-is-python3 \
      rsync sudo unzip xz-utils zip; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc; \
    chmod a+r /etc/apt/keyrings/docker.asc; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends docker-buildx-plugin docker-ce-cli docker-compose-plugin; \
    rm -rf /var/lib/apt/lists/*; \
    curl -fsSL "https://github.com/jj-vcs/jj/releases/download/v${JJ_VERSION}/jj-v${JJ_VERSION}-${jj_arch}.tar.gz" -o /tmp/jj.tar.gz; \
    echo "${jj_sha}  /tmp/jj.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/jj.tar.gz -C /usr/local/bin ./jj; \
    curl -fsSL "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-${mise_arch}.tar.gz" -o /tmp/mise.tar.gz; \
    echo "${mise_sha}  /tmp/mise.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/mise.tar.gz -C /usr/local/bin --strip-components=2 mise/bin/mise; \
    MISE_DATA_DIR=/opt/mise MISE_CACHE_DIR=/tmp/mise-cache mise install "node@${NODE_VERSION}"; \
    ln -s "/opt/mise/installs/node/${NODE_VERSION}/bin/node" /usr/local/bin/node; \
    for command in corepack npm npx; do printf '#!/bin/sh\nexec /opt/mise/installs/node/%s/bin/%s "$@"\n' "${NODE_VERSION}" "${command}" > "/usr/local/bin/${command}"; chmod +x "/usr/local/bin/${command}"; done; \
    for command in pnpm yarn; do printf '#!/bin/sh\nexec /usr/local/bin/corepack %s "$@"\n' "${command}" > "/usr/local/bin/${command}"; chmod +x "/usr/local/bin/${command}"; done; \
    curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep-${RIPGREP_VERSION}-${rg_arch}.tar.gz" -o /tmp/rg.tar.gz; \
    echo "${rg_sha}  /tmp/rg.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/rg.tar.gz -C /usr/local/bin --strip-components=1 "ripgrep-${RIPGREP_VERSION}-${rg_arch}/rg"; \
    curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${uv_arch}.tar.gz" -o /tmp/uv.tar.gz; \
    echo "${uv_sha}  /tmp/uv.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/uv.tar.gz -C /usr/local/bin --strip-components=1 "uv-${uv_arch}/uv" "uv-${uv_arch}/uvx"; \
    curl -fsSL "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_${TARGETARCH}" -o /usr/local/bin/yq; \
    echo "${yq_sha}  /usr/local/bin/yq" | sha256sum -c -; \
    chmod +x /usr/local/bin/yq; \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" -o /tmp/gh.tar.gz; \
    echo "${gh_sha}  /tmp/gh.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/gh.tar.gz -C /usr/local/bin --strip-components=2 "gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh"; \
    rm -rf /tmp/jj.tar.gz /tmp/mise.tar.gz /tmp/mise-cache /tmp/rg.tar.gz /tmp/uv.tar.gz /tmp/gh.tar.gz; \
    mkdir -p /etc/profile.d; \
    printf '%s\n' \
      '# Debian /etc/profile resets PATH for every login shell, discarding the' \
      '# PATH this image sets. Restore the workspace locations that survive a' \
      '# wake: user-level installs and mise shims under $HOME/.local.' \
      'if [ -n "${HOME:-}" ]; then' \
      '  PATH="${HOME}/.local/bin:${PATH}"' \
      '  PATH="${HOME}/.local/share/mise/shims:${PATH}"' \
      'fi' \
      'if [ -n "${MISE_DATA_DIR:-}" ]; then' \
      '  PATH="${MISE_DATA_DIR}/shims:${PATH}"' \
      'fi' \
      'export PATH' \
      > /etc/profile.d/dsh-path.sh; \
    chmod 0755 /etc/profile.d/dsh-path.sh; \
    mkdir -p /workspace /run/dsh; \
    useradd --create-home --uid 1000 --home-dir /workspace/home sandbox; \
    printf '%s\n' \
      '# dsh-yawn: passwordless root for the sandbox user, so a repository setup' \
      '# hook such as buildkite/agent .agents/setup can install system packages' \
      '# with apt-get. On Kubernetes the pod template must allow privilege' \
      '# escalation, because no_new_privs otherwise makes the setuid transition' \
      '# a no-op; see deploy/kubernetes/runner/20-sandbox-template.yaml.' \
      'sandbox ALL=(ALL:ALL) NOPASSWD: ALL' \
      > /etc/sudoers.d/90-sandbox; \
    chmod 0440 /etc/sudoers.d/90-sandbox; \
    visudo -cf /etc/sudoers.d/90-sandbox; \
    chown -R sandbox:sandbox /workspace /run/dsh; \
    install -d "${AGENT_BROWSER_INSTALL_DIR}"; \
    npm install -g --prefix "${AGENT_BROWSER_INSTALL_DIR}" "agent-browser@${AGENT_BROWSER_VERSION}"; \
    ln -s "${AGENT_BROWSER_INSTALL_DIR}/bin/agent-browser" /usr/local/bin/agent-browser; \
    chown -R sandbox:sandbox "${AGENT_BROWSER_INSTALL_DIR}"; \
    apt-get clean; \
    rm -f /etc/apt/apt.conf.d/docker-clean; \
    printf '%s\n' \
      '# dsh-yawn: keep downloaded .deb files on the workspace volume, so a' \
      '# machine rebuilt around that volume re-installs the system packages a' \
      '# repository setup needs without downloading them again. The runner' \
      '# creates the directory; keep the path equal to its aptCacheDir.' \
      '# Written last, after the apt installs above, so those layers stay small.' \
      'Dir::Cache::Archives "/workspace/.dsh-yawn/apt-cache/";' \
      'APT::Keep-Downloaded-Packages "true";' \
      > /etc/apt/apt.conf.d/90-dsh-yawn
# The PTC Node backend runs its bootstrap inside the sandbox: the provider
# resolves that file in the execution world, and its own copy is a control-plane
# path no sandbox can see. Ship the pinned copy here and name it in the bundle
# patch (control-plane/cordis.patch.yml). Keep the version equal to the dsh pin
# in control-plane/package.json; a control-plane test asserts it, and a
# mismatched bootstrap fails the PTC control handshake.
ARG DSH_PTC_RUNTIME_VERSION=0.2.1-rc.2
RUN set -eux; \
    mkdir -p /opt/dsh-yawn/ptc-runtime-node; \
    cd /tmp; \
    tarball="$(npm pack "@deepseek-ai/dsh-ptc-runtime-node@${DSH_PTC_RUNTIME_VERSION}")"; \
    tar -xzf "${tarball}" -C /opt/dsh-yawn/ptc-runtime-node --strip-components=2 package/lib/process.js; \
    rm -f "${tarball}"; \
    cp /opt/dsh-yawn/ptc-runtime-node/process.js /tmp/ptc-bootstrap.mjs; \
    node --check /tmp/ptc-bootstrap.mjs; \
    rm -f /tmp/ptc-bootstrap.mjs
# The setup marker lives on the machine's own filesystem, not on the workspace
# volume, so a machine rebuilt around the surviving volume runs the repository's
# setup again. The sandbox user writes the marker; see markerPath in
# runner/service/setup.go. Keep this image free of the marker file itself.
RUN install -d -o sandbox -g sandbox -m 0755 /var/lib/dsh-yawn
# The on-demand browser bootstrap ships in the image the session runs, so that
# a session runs the copy pinned to its own image instead of the control plane
# having to send one through the skill body.
COPY install-browser.sh /usr/local/bin/install-browser
RUN chmod 0755 /usr/local/bin/install-browser && sh -n /usr/local/bin/install-browser
COPY --from=build /dsh-yawn-runner /usr/local/bin/dsh-yawn-runner
# The sandbox account's home lives on the workspace volume so files and caches survive a
# Kubernetes wake. A sandbox mounts its workspace volume over /workspace, which
# hides this image's copy, so the runner recreates the directory at startup.
# Leave HOME unset so the runtime uses the starting user's passwd entry:
# /workspace/home for sandbox, /root for root (including hosted agent hooks).
# npm's default global prefix is the root-owned Node install, where
# `npm install -g` fails with EACCES; $HOME/.local is writable, is on PATH,
# and is on the workspace volume, so global installs work and survive a wake.
# mise keeps its default data directory under $HOME too, so no override is set.
# The agent-browser CLI sits outside both $HOME and /workspace for the same
# volume reason, and is linked onto PATH under a name that outlives the mount.
ENV NPM_CONFIG_PREFIX=/workspace/home/.local \
    PATH=/workspace/home/.local/share/mise/shims:/opt/mise/installs/node/${NODE_VERSION}/bin:$PATH
WORKDIR /workspace
EXPOSE 8080

# GHCR links the image to the GitHub repository this label names.
LABEL org.opencontainers.image.source="https://github.com/zhming0/dsh-yawn"

CMD ["dsh-yawn-runner"]
