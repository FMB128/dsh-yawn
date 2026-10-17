# The control-plane image: dsh with the `web` profile assembled around the
# dsh-yawn control plane. The build derives the dsh version from the
# control-plane's own dependency pins and asserts that the CLI the image locks
# is the same version, so control-plane/package.json stays the single source
# of truth for which dsh this distribution ships.
#
# Layout rule: the image owns the software, the home volume owns the data.
# The runtime user's home is /data, so dsh sessions ($HOME/.dsh) and the
# control plane's state ($HOME/.dsh-yawn) land on one mount with no path
# configuration.

# Keep the Node version equal to mise.toml, which pins it for CI and local
# development and records why it stays below 24.20.0 (nodejs/node#65677).
FROM node:24.19.0-bookworm-slim AS build
ARG VERSION=0.0.0-dev
WORKDIR /build
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY control-plane/ control-plane/
RUN pnpm install --frozen-lockfile --filter @zhming0/dsh-yawn

# Pack the control plane as a real npm tarball (prepack builds it), so the runtime
# stage installs it exactly like a registry package, dependencies included.
# The control plane derives its default runner image tag from its own version, so
# the release invariant "both images share one tag" is checked right here,
# where the version is stamped.
RUN mkdir -p /out/meta \
    && npm --prefix control-plane version "$VERSION" --no-git-tag-version --allow-same-version \
    && pnpm --dir control-plane pack --out /out/dsh-yawn.tgz \
    && node --input-type=module -e " \
        import { DEFAULT_RUNNER_IMAGE } from './control-plane/dist/runner-image.js'; \
        const expected = ':' + process.env.VERSION; \
        if (!DEFAULT_RUNNER_IMAGE.endsWith(expected)) { \
          throw new Error('default runner image ' + DEFAULT_RUNNER_IMAGE + ' does not end with ' + expected); \
        }" \
    && node -e " \
        const peer = require('./control-plane/package.json').peerDependencies['@deepseek-ai/dsh-agent']; \
        const cli = require('./control-plane/image/dsh-cli/package.json').dependencies['@deepseek-ai/dsh']; \
        if (cli !== peer) { \
          throw new Error('the image @deepseek-ai/dsh dependency ' + cli + ' does not match the pinned @deepseek-ai/dsh-agent ' + peer + '; update both and regenerate its lockfile'); \
        }" \
    && node -p "require('./control-plane/package.json').peerDependencies['@deepseek-ai/dsh-agent']" >/out/meta/dsh-version \
    && node -p "require('./package.json').packageManager" >/out/meta/package-manager \
    && printf '%s\n' "$VERSION" >/out/meta/version

FROM node:24.19.0-bookworm-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# git backs the control plane's repository auto-detect fallback
# (`git remote get-url origin`) for sessions not created from a repository
# Workspace. The docker CLI lets the Docker backend manage sibling sandbox
# containers when the control plane itself runs in a container; it is the
# same static binary the sandbox pods' dind sidecar ships (docker:29.8.0).
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker:29.8.0-cli /usr/local/bin/docker /usr/local/bin/docker

COPY --from=build /out/meta /opt/dsh-yawn/meta
COPY --from=build /out/dsh-yawn.tgz /opt/dsh-yawn/dsh-yawn.tgz

# The dsh CLI comes from its own lockfile (control-plane/image/dsh-cli), not a
# fresh registry resolution. The pinned release's dependency ranges float onto
# newer prereleases, and upstream can publish one of those incomplete, which
# breaks the install. `npm ci` installs exactly the locked tree, and the
# version check keeps the image on the version control-plane/package.json
# pins. Bumping the CLI means editing that package.json and regenerating its
# lockfile. pnpm is what `dsh plugin` forwards to.
COPY control-plane/image/dsh-cli/package.json control-plane/image/dsh-cli/package-lock.json /opt/dsh-yawn/cli/
RUN corepack install -g "$(cat /opt/dsh-yawn/meta/package-manager)" \
    && corepack enable pnpm \
    && cd /opt/dsh-yawn/cli \
    && npm ci --no-audit --no-fund \
    && npm cache clean --force \
    && test "$(./node_modules/.bin/dsh --version)" = "$(cat /opt/dsh-yawn/meta/dsh-version)"
ENV PATH="/opt/dsh-yawn/cli/node_modules/.bin:$PATH"

# Assemble the web profile once, at build time, with the real installer, so
# the baked composition is exactly what `dsh plugin add` produces. The shipped
# template seeds a placeholder cordis.patch.yml (an empty patch list); drop it
# from the baked profile because that file is the user's, seeded separately by
# dsh-yawn-seed and never refreshed.
RUN DSH_HOME=/opt/dsh-yawn/seed dsh plugin --profile web add /opt/dsh-yawn/dsh-yawn.tgz \
    && rm /opt/dsh-yawn/seed/profiles/web/cordis.patch.yml \
    && mv /opt/dsh-yawn/seed/profiles/web /opt/dsh-yawn/profile \
    && rm -rf /opt/dsh-yawn/seed \
    && cp /opt/dsh-yawn/meta/version /opt/dsh-yawn/version

COPY control-plane/image/settings.patch.yml control-plane/image/launch-token.patch.yml control-plane/image/profile-refresh.mjs /opt/dsh-yawn/
COPY control-plane/image/seed /usr/local/bin/dsh-yawn-seed
COPY control-plane/image/entrypoint /usr/local/bin/dsh-yawn-entrypoint

# The node base image reserves uid 1000 for its unused `node` user; take it
# over so the volume-mounted /data has a predictable owner.
RUN userdel -r node \
    && useradd --uid 1000 --create-home --home-dir /data dsh \
    && chown -R dsh:dsh /opt/dsh-yawn

# The entrypoint starts as root only to join the mounted Docker socket's group
# and then drops to uid 1000 before running anything; see
# control-plane/image/entrypoint. A pod that sets runAsUser (the Helm chart
# does) skips the drop and never runs as root.
USER root
ENV HOME=/data
WORKDIR /data
EXPOSE 3000

# GHCR links the image to the GitHub repository this label names.
LABEL org.opencontainers.image.source="https://github.com/zhming0/dsh-yawn"

ENTRYPOINT ["dsh-yawn-entrypoint"]
