# Development

How to build and test dsh-yawn, run it from a checkout, and cut a release. For
what the project is and how to deploy it, start with the
[README](../README.md).

## Repository layout

| Path                 | Purpose                                                                            |
| -------------------- | ---------------------------------------------------------------------------------- |
| `control-plane/`     | TypeScript dsh plugin: lifecycle policy, backends, secret store, Web UI extensions |
| `runner/`            | Go server that runs inside each sandbox                                            |
| `proto/`             | ConnectRPC interface shared by the control plane and runner                        |
| `deploy/helm/`       | Helm chart for the control plane                                                   |
| `deploy/kubernetes/` | Kustomize base for the Kubernetes sandbox pool                                     |
| `scripts/kas/`       | Disposable kind cluster and lifecycle smoke test                                   |
| `examples/`          | Agent preset for the per-session route                                             |

## Build and test

[`mise.toml`](../mise.toml) pins Node, Go, the protobuf plugins, and the linter
binaries. CI installs the same versions, so a local build and CI agree. Install
[mise](https://mise.jdx.dev), then:

```sh
mise install
corepack enable pnpm
```

pnpm itself is pinned by `packageManager` in `package.json`, which corepack
reads. Buf comes with `pnpm install`. Docker is needed for the end-to-end local
test.

```sh
pnpm install
pnpm check
pnpm lint
pnpm test
pnpm build

(cd runner && go test -race ./... && go build ./cmd/dsh-yawn-runner)
docker buildx bake dev --load
pnpm test:docker
docker buildx bake dev control-plane-dev --load
pnpm test:kas
```

`docker buildx bake dev` builds the runner image for the current machine. The
release build covers `linux/amd64` and `linux/arm64`.

The Docker smoke test checks runner registration, secret injection, bundled
command-line tools, first-run setup, and file survival across stop/start. The
Kubernetes test creates a disposable kind cluster and checks the
control-plane-to-runner tunnel, forced reconnection, hibernate/wake, warm
adoption, volume persistence, and expiry.

`pnpm lint` runs ESLint with type-aware rules for the control plane and
golangci-lint for the runner. Both focus on real defects such as unchecked
errors and promises, dead code, and suspicious constructs; formatting is
handled by prettier and gofmt.

After editing a protobuf file:

```sh
pnpm proto:generate
```

For focused Kubernetes development, `scripts/kas/dev-cluster.sh` creates a
cluster you can inspect between runs, and `scripts/kas/smoke-test.sh` checks the
controller lifecycle against it. See
[e2e-testing.md](e2e-testing.md) for both workflows.

## Running from a checkout (laptop + Docker)

A checkout install uses a dsh you run yourself instead of the released images.
It needs the pinned `@deepseek-ai/dsh` version from
`control-plane/package.json` (0.2.1-rc.1) on your PATH. Build first, then
install the control-plane directory:

```sh
docker buildx bake dev --load
pnpm install && pnpm build
dsh plugin --profile web add "$PWD/control-plane"
```

`scripts/dev.mjs start` does those steps in a scratch `DSH_HOME` instead of
yours, points it at a Docker sandbox profile, and runs `dsh web` in the
foreground on free ports (`--port` pins one). It also settles the address a
sandbox dials to reach the tunnel. The profile's default,
`host.docker.internal`, is mapped to the host by a daemon running as root; a
rootless daemon points it at a bridge nothing listens in, where every runner
fails to register. So a short-lived container asks which candidate address
reaches the tunnel port, and the winner becomes the profile's
`controlPlaneUrl` (`--control-plane-url` names one instead; a probe that finds
nothing leaves the default). The launcher prints the tokenized URL, and Ctrl-C
stops it. `clean` removes what a run left behind: a control plane still running
from that home, and the sandboxes its sessions created, which outlive the
control plane because they are children of the Docker daemon. A later `start`
cleans them too before replacing the home. Use it for acceptance runs so your
own profile stays untouched.

To exercise the profile picker without a cluster, declare two Docker profiles
with the same image and different names:

```yaml
- id: sandbox-manager
  config:
    profiles:
      standard: { backend: docker, image: dsh-yawn-runner:dev }
      large: { backend: docker, image: dsh-yawn-runner:dev }
```

## Releasing

Every release publishes two images for `linux/amd64` and `linux/arm64`:
`ghcr.io/zhming0/dsh-yawn-control-plane` (the dsh distribution with the web
profile and this control plane) and `ghcr.io/zhming0/dsh-yawn-runner`. They
share one calendar version. The control-plane build fails if its default runner
image tag would not match, so the pair cannot drift.

The control plane is not published to npm. The distribution images are the
product; a checkout install is the contributor path.

Buildkite runs [`.buildkite/pipeline.yml`](../.buildkite/pipeline.yml) on every
branch: control-plane checks and tests, runner tests, a generated-protobuf
check, the Docker lifecycle smoke test, and the Kubernetes transport and
lifecycle test.

On `main`, a manual block step runs
[`.buildkite/pipeline.release.yml`](../.buildkite/pipeline.release.yml), which
picks a calendar version, pushes both multi-architecture images, stamps that
version into the chart's `appVersion`, and publishes the chart to
`ghcr.io/zhming0/charts`. The release commits nothing: `main` is protected by a
ruleset requiring a pull request and the `buildkite/dsh-yawn` check, so the
version stamp stays in the build checkout. The checked-in chart `version` and
`appVersion` can therefore lag the published chart.
