# DeepSeek Harness Yawn

<p align="center">
  <img src="docs/logo.png" alt="Project logo" style="max-width: 100%; width: 200px;" />
</p>

<p align="center">
  <strong>Always-on DeepSeek Harness for the web.</strong><br>
  A self-hosted distribution: deploy it once, open it from any browser, and
  every session runs in its own sandbox.
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/hero-dark.svg">
    <img alt="A task sent from a laptop runs in its own sandbox behind an always-on control plane. The laptop closes and the work continues. The idle sandbox sleeps and keeps its files, then wakes when a phone sends the next message." src="docs/hero-light.svg" width="960">
  </picture>
</p>

## Why

[DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) is a great
harness, but it assumes it runs on your laptop: every session shares your
operating system, so you have to watch what the agents do, keep the machine
awake, and live with the scale of one machine. DSH Yawn splits dsh in two: the
harness itself runs on a server you keep on, and everything the agent does runs
in a sandbox of its own. Hence the name: you can lay back and yawn :)

|                                               | dsh on your laptop          | DSH Yawn                                                                          |
| --------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------- |
| dsh itself (Web UI, sessions, model calls)    | your laptop                 | an always-on server: a VM or a Kubernetes cluster                                 |
| The agent's work (shell commands, file edits) | your laptop                 | a sandbox per session: a Docker container, a Kubernetes pod, or a Buildkite build |
| Where you open it                             | that laptop                 | any browser, after signing in                                                     |
| Many sessions at once                         | share one OS, CPU, and disk | one sandbox each, on your VM, cluster, or Buildkite agents                        |
| Starting on a repository                      | your local checkout         | paste a URL; the sandbox clones it and runs `.agents/setup`                       |
| Secrets                                       | your shell environment      | a store on the server, pushed to a sandbox before commands                        |

## What's in the distribution

- Control-plane and runner images, released and tested together, and a Helm
  chart.
- dsh's Web UI, with its file, shell, and search tools running in the session's
  sandbox.
- Sandbox backends: Docker, Kubernetes
  [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) with warm
  pools, and Buildkite.
- Built-in OIDC sign-in with your identity provider, so the Helm chart needs no
  auth proxy.
- Web UI pages for sandbox profiles and idle timers, secrets, AGENTS.md
  instructions, notifications, MCP servers, and plugins, applied without a
  restart.
- In every session: a Sandbox tab, a file browser, and a terminal.
- Previews: a dev server in a sandbox gets its own URL.

## Requirements

- An always-on place for the control plane: a VM with Docker, or a Kubernetes
  cluster through the Helm chart.
- The ability to expose it under a domain name, on the internet or your LAN.
- Somewhere to run sandboxes: Docker on the same VM, a Kubernetes cluster with
  [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox), or a
  Buildkite organization.
- Sign-in for the Web UI. The Helm chart runs built-in OIDC sign-in against your
  provider; on a VM, set the same `DSH_YAWN_OIDC_*` names.
- A model API key, added in the Web UI.
- Optional: a `GITHUB_TOKEN` for private repositories and pushes.

Setup: [`docs/installations.md`](docs/installations.md).

## Quick start

This runs the control plane in Docker and starts each session's sandbox as a
sibling container: the whole install on one machine. The same shape works on a
VM.

```sh
docker run -d --name dsh-yawn \
  -p 127.0.0.1:3000:3000 -p 8081:8081 \
  -e DSH_YAWN_BIND_ALL=1 \
  -e DSH_YAWN_CONTROL_PLANE_LAUNCH_TOKEN_ROUTE=1 \
  -v dsh-yawn-data:/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/zhming0/dsh-yawn-control-plane
```

1. Open <http://localhost:3000/launch-token>.
2. **Settings → Sandboxes → New profile**: `name: standard`, `backend: docker`.
3. Add a model credential in the Web UI settings.
4. Send a message in the **Scratch** workspace, whose sessions start in an
   empty sandbox, or use **New session → Add workspace…** with a repository URL.

To clean up: `docker rm -f dsh-yawn`. What each flag does is in the
[FAQ](docs/faq.md#what-does-the-quick-start-command-do).

## Documentation

| Page                                                       | Covers                                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| [`docs/installations.md`](docs/installations.md)           | installation index: control plane, runner, credentials                      |
| [`docs/control-plane.md`](docs/control-plane.md)           | the control plane on Kubernetes (Helm chart) or on a VM with Docker         |
| [`docs/credentials.md`](docs/credentials.md)               | the secret store: `GITHUB_TOKEN`, the Web UI, control-plane credentials     |
| [`docs/runners/kubernetes.md`](docs/runners/kubernetes.md) | sandboxes as Kubernetes pods: install, security model, what survives a wake |
| [`docs/runners/buildkite.md`](docs/runners/buildkite.md)   | sandboxes as Buildkite builds: pipeline, idle checkpoints, limits           |
| [`docs/faq.md`](docs/faq.md)                               | launch tokens, sandbox lifecycle, the runner tunnel, plugins                |
| [`control-plane/README.md`](control-plane/README.md)       | what the bundle patch changes, every setting, secret handling               |
| [`docs/development.md`](docs/development.md)               | repository layout, build and test, checkout installs, releasing             |
