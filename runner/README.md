# dsh-yawn-runner

`dsh-yawn-runner` is the process that runs inside each sandbox. It connects
out to the control plane and serves file, shell, subprocess, Docker, and
terminal requests; it accepts no inbound RPCs.

`DSH_YAWN_CONTROL_PLANE_URL` is the tunnel endpoint as a WebSocket URL
(`ws://host:port/tunnel`, or `wss://host/tunnel` through an HTTPS proxy that
terminates TLS in front of the control plane). The runner identifies itself
with `DSH_YAWN_SANDBOX_ID` and authenticates with the shared secret in
`DSH_YAWN_REGISTRATION_TOKEN` (or a file named by
`DSH_YAWN_REGISTRATION_TOKEN_FILE`), sent as a bearer token and the
`X-Dsh-Yawn-Sandbox-Id` header on the upgrade request.

Once connected, the runner serves RPCs over that same WebSocket and redials
with backoff whenever the tunnel drops. RPCs are reachable only over tunnels
the runner itself opened. `wss://` certificates are checked against the system
CA bundle; point `SSL_CERT_FILE` at a private CA if the proxy uses one.

Secrets and Git credentials exist only in process memory. Child processes get a
small allowlisted base environment, the current secrets, and RPC-supplied
overrides; they do not inherit the runner environment. Git obtains credentials
from a mode-0600 Unix socket at `CREDENTIAL_SOCKET` (default
`/run/dsh/credentials.sock`) through `dsh-yawn-runner git-credential`.

Setup defaults to `/workspace/repository`, preserves an already initialized
workspace, and runs the repository's `.agents/setup` hook once per machine. The
completion marker is `/var/lib/dsh-yawn/setup-done`, on the machine's own
filesystem and not on the workspace volume, so a rebuilt machine runs setup
again while a machine that stayed alive does not. The entry in `Setup`'s
response means a setup run happened on this call; a machine that already ran it
answers `false`. A setup hook runs on a checkout that may already carry an
earlier run's output — possibly with a session's uncommitted work — so it must
be safe to re-run. Setup creates the apt cache directory
`/workspace/.dsh-yawn/apt-cache`, which the image's apt configuration names, so
system packages a setup installs are downloaded once per workspace volume;
after a successful setup it trims that cache with `apt-get autoclean` and
clears it past 2 GiB.

Keeping the checkout beneath the persistent volume root prevents filesystem metadata
such as `lost+found` from entering the repository. The file APIs operate with
the container user's permissions; they are not a filesystem sandbox. Run the
image as its non-root `sandbox` user (UID/GID 1000) and isolate its
filesystem/network at the container platform boundary. The image leaves `USER`
unset for Buildkite hosted agents, so a plain `docker run` defaults to root.
The Docker backend and documented Buildkite command pass `--user 1000:1000`;
the Kubernetes template sets the identity through its security context.

The home directory is `/workspace/home`, also on the workspace volume, so
package caches, tool configuration, and anything installed under `$HOME`
survive hibernation. The runner creates the directory at startup because a
Kubernetes sandbox mounts its workspace volume over `/workspace` and hides the
image's copy. Files outside `/workspace`, `/tmp` among them, do not survive a
wake.

Global installs need no root: `NPM_CONFIG_PREFIX` sends `npm install -g` to
`$HOME/.local`, `uv tool install` uses `$HOME/.local/bin`, and mise keeps its
default data directory at `$HOME/.local/share/mise`. A `/etc/profile.d` script
puts those directories back on `PATH` for login shells, which Debian's
`/etc/profile` would otherwise reset.

The `sandbox` user has passwordless sudo (`/etc/sudoers.d/90-sandbox`), so a
repository whose own setup installs system packages, as `mise bootstrap
packages apply` does for an `apt:` entry, needs no custom image. The
Kubernetes template allows privilege escalation for that. What apt installs
still lives outside `$HOME`, so it goes away with the machine — but the
workspace volume carries the downloaded `.deb` files, and the machine that
replaces it runs setup again, so the same packages come back without a second
download. Files under `$HOME`, the workspace volume, are the ones that survive
by themselves.

`GET /health` on `ADDR` (default `:8080`) is an unauthenticated
process-readiness probe for the kubelet; it is the only listener the runner
opens and does not expose sandbox data or RPCs.

The reference Dockerfile builds `linux/amd64` and `linux/arm64`. It includes
Git, GitHub CLI, Jujutsu, mise, ripgrep, Python with uv, Node.js,
Corepack-backed pnpm and Yarn, a native build toolchain, common archive and
process utilities, jq, yq, and the Docker CLI with Buildx and Compose. It
deliberately excludes pip, the Docker daemon, and the container runtime;
platforms that want Docker commands to reach a daemon must provide one
separately. Architecture-specific archives have pinned checksums, and the Go
stage cross-compiles from the builder's own architecture rather than running
the toolchain under emulation.

It also installs the `agent-browser` CLI and `install-browser`, the bootstrap
the `using-agent-browser` skill runs. The browser itself is deliberately
absent, and so are the libraries and the font it needs to draw: together they
are far larger than everything else here, and a task drives a page rarely
enough that paying for them on every pull is the wrong trade. `install-browser`
adds them to a session on first use, into the workspace volume so a
hibernation keeps them.

The CLI sits in `/opt/agent-browser` and is linked onto `PATH`, outside both
`$HOME` and `/workspace`, because a session mounts its workspace volume over
`/workspace` and would otherwise hide it.

The image also carries the PTC Node backend's bootstrap in
`/opt/dsh-yawn/ptc-runtime-node/process.js`. dsh's PTC mode runs model-written
programs in a fresh Node child inside the sandbox, the provider resolves that
file in the execution world, and its own copy is a path no sandbox has — so the
pinned copy ships here and the control plane's bundle patch names it. Keep the
Dockerfile's `DSH_PTC_RUNTIME_VERSION` equal to the dsh pin in
`control-plane/package.json`: a control-plane test asserts it, and a bootstrap
from another release fails the control handshake.

Releases are published to `ghcr.io/zhming0/dsh-yawn-runner`, tagged with the same
version as the `@zhming0/dsh-yawn` package that expects them.

When standard `OTEL_EXPORTER_OTLP_*`, `OTEL_TRACES_EXPORTER`, or
`OTEL_METRICS_EXPORTER` settings are present, the runner exports HTTP traces and
command-duration metrics. With no exporter settings, telemetry stays local and
the runner does not try to contact a collector.
