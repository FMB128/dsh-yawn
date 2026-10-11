# dsh-yawn control plane

This package connects DeepSeek Harness sessions to isolated environments. It
owns the sandbox lifecycle and replaces dsh's host filesystem, shell, and
subprocess services with sandbox-backed ones. The normal dsh tools keep working
and run inside the session's sandbox.

The package ships pre-installed in the
`ghcr.io/zhming0/dsh-yawn-control-plane` image and is not published to npm. For
development, install a checkout:

```sh
dsh plugin --profile web add "$PWD/control-plane"
```

The [repository README](../README.md) covers the whole setup. This page is the
package reference: what the package changes, every setting, and its limits.
For dsh plugin internals and implementation notes, see
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## What the package changes

- `read`, `write`, `edit`, `present`, `bash`, `glob`, and `grep` run in the
  session's sandbox instead of on the control-plane host.
- Sessions can provision sandboxes through Docker, Kubernetes
  agent-sandbox, or a Buildkite pipeline. A **sandbox profile** names one
  backend and its settings; a session picks a profile on its first prompt.
- The Web UI gains pages for secrets, sandbox profiles, instructions,
  notifications, MCP servers, plugins, a Sandbox tab, a right sidebar for
  files and terminal access, repository URL Workspaces, and a Scratch
  Workspace without a repository.
- Uploaded attachments and `@` file references are copied from or resolved in
  the sandbox workspace.
- Sessions can install plugins from the Web Plugins page, but those run in the
  control-plane process with the control plane's access to sessions and
  credentials.

## What changes for the agent

The tools keep their names, schemas, and prompt guidance; only where they run
changes.

|                                    | Before                    | After                                     |
| ---------------------------------- | ------------------------- | ----------------------------------------- |
| `read`, `write`, `edit`, `present` | your disk                 | sandbox workspace                         |
| `bash`                             | your machine              | sandbox                                   |
| `run_code` (the `ptc` preset)      | your machine              | a Node child in the sandbox               |
| `glob`, `grep`                     | ripgrep on your machine   | sandbox workspace, ripgrep in the sandbox |
| Working directory                  | wherever you launched dsh | `/workspace/repository` in the sandbox    |
| `docker`                           | your Docker daemon        | a rootless daemon in the sandbox pod      |
| Session logs, spill files          | your disk                 | unchanged, still your disk                |
| Uploaded attachments               | your disk                 | copied into the sandbox workspace         |

On Kubernetes the `docker` tool uses a rootless `dockerd` sidecar; see
[Docker inside a sandbox](../docs/runners/kubernetes.md#docker-inside-a-sandbox) for
the security trade it makes and how to remove it.

## Plugins

The Web sidebar's **Plugins** page manages the profile's plugins (dsh calls an
installed package a _bundle_). It installs a package name, a Git address, a
tarball, or a local path; enables, disables, and removes plugins; and switches
individual plugin entries. The same operations
are `dsh plugin --profile web ...` in the control-plane pod. A package without
`dsh.bundle.patch` installs as a plain dependency and changes nothing. The
stock `cordis` agent preset also enables the `plugin_manager` tool, which asks
for approval on each call.

Plugins run in the control-plane process, outside every sandbox and with the
control plane's access to sessions and credentials, so the page is operator
access. The page also lists this package's own plugin: switching
`@zhming0/dsh-yawn` off drops it from the profile's plugin list and unmounts
the sandbox services until it is switched back on (the next image upgrade
merges the image's plugin list back in).

`dsh-yawn-seed` seeds the profile from `/opt/dsh-yawn/profile` on first boot.
On an image upgrade it merges the image's manifest fields — the
`@zhming0/dsh-yawn` dependency and the plugin selection the image ships — into
the profile on the data volume and runs `pnpm update @zhming0/dsh-yawn`, so
everything the user installed stays. `cordis.patch.yml` and
`pnpm-workspace.yaml` are seeded once and then the user's; the workspace file
is where pnpm records dependency build-script approvals. A refresh that fails
reseeds the profile from the image and logs a warning, but keeps the manifest
it was working from as `package.json.before-reseed` and leaves the version
marker alone: the next boot merges that manifest back in and retries.

## Settings

Configuration is YAML in the profile's own layer,
`$DSH_HOME/profiles/<name>/cordis.patch.yml`. A plugin's `config` replaces
the previous config entirely, so restate every field you want to keep.

```yaml
- id: sandbox-manager
  config:
    profiles:
      standard:
        backend: docker
    idleMs: 300000
```

The fields below are live settings, so everything marked _live_ can be changed
at runtime through the Web UI's **Settings → Sandboxes** page and
applies without a restart. Since dsh 0.1.7 those edits persist back into the
profile's own `cordis.patch.yml` (the same file the image seeds once), a reset
returns to the value beneath the edit, and a change re-resolves the profiles
(backends of unchanged profiles are kept), the default profile, and the idle
and expiry timers, which take effect for the next armed countdown and the next
hibernation. Sessions that already have a sandbox keep it; a profile whose
sessions are still on record can be removed, and those sessions behave exactly
as they do across a restart with the profile missing.

A deployment can supply defaults beneath those settings in the top-level
`sandboxManager` section of `/etc/dsh-yawn/sandbox-settings.yaml`: the same
runtime settings as an ordinary file. The chart renders
`controlPlane.sandboxManager` there. A plain file is deliberate here: dsh gives
a home-level setting precedence over the profile's, which would make the Web
page's writes appear overridden. The base merges field by field into the
plugin's config. A profile the deployment defines is locked: the page
shows it as deployment and cannot edit or remove it, and the deployment's
definition wins if a page entry reuses its name. The page's default profile
and timers win over the deployment's, and a reset returns to them. An absent
file means the deployment sets nothing.

The section layout is an interface between the chart and the image, and the
image tag can lag the chart's, so a section this package does not know is
ignored. The file
stays specific to this package; other plugins own their own settings.

Writes are validated where they land: the host keeps the last good values
with a warning rather than stopping when a slice turns invalid (a
`defaultProfile` no profile defines, a timer out of range), and every write
carries the revision it read, so a concurrent editor is refused as a conflict
instead of being overwritten.

The settings page is writable by anyone the control plane admits, like the
Secrets page: one control plane is one operator domain. The stock dsh
settings mirror refuses to persist writes from a non-loopback page, which is
every page of a deployed control plane, so this page talks to the settings
API directly instead of through it.

Fields marked _boot_ are read once at startup — the state directory must
exist before any settings store could, and the tunnel listener binds before
the Web UI is up. They live in the profile patch; the deployment base carries
the runtime slice only.

`profiles` may be empty. The host then boots and serves sessions normally,
but the first prompt fails with `no sandbox profile is configured` until a
profile is added; nothing is provisioned and no backend is contacted. That is
the intended state while installing the control plane before its sandbox
backend exists, and it keeps a mistyped profile map from stopping the host from
starting, so the settings can still be corrected.

| Setting           | When | Default                 | Meaning                                                                                     |
| ----------------- | ---- | ----------------------- | ------------------------------------------------------------------------------------------- |
| `profiles.<name>` | live | none                    | One sandbox profile; its fields are listed in the next table                                |
| `defaultProfile`  | live | first profile           | Profile used when a session does not pick one                                               |
| `idleMs`          | live | 10 minutes              | Idle delay after the last turn or wake before hibernating                                   |
| `expiresAfterMs`  | live | 7 days                  | How long a hibernated workspace is retained                                                 |
| `readyTimeoutMs`  | live | per backend             | Ready timeout for `kas` and `buildkite` profiles that do not set their own                  |
| `repository`      | boot | session repository      | Fallback repository for non-anchor sessions                                                 |
| `revision`        | boot | repository default      | Optional branch, tag, or commit to check out                                                |
| `workspace`       | boot | `/workspace/repository` | Repository checkout and working directory                                                   |
| `stateDir`        | boot | `~/.dsh-yawn`           | Records, secret store, registration token, instructions, MCP servers, and Workspace anchors |
| `tunnel.port`     | boot | `8081`                  | Port the host listens on for runner tunnels (see Tunnel)                                    |
| `tunnel.bind`     | boot | `0.0.0.0`               | Address the tunnel listener binds to                                                        |
| `preview.domain`  | boot | none                    | Domain serving previews (see Previews); unset disables them                                 |
| `preview.port`    | boot | `8082`                  | Port the preview listener binds to                                                          |
| `preview.bind`    | boot | `0.0.0.0`               | Address the preview listener binds to                                                       |

Each profile carries the settings of its own backend. Profiles do not share
settings with each other, so two Kubernetes profiles in one namespace both
name that namespace. The exceptions are the two timers: a profile's `idleMs`
and `readyTimeoutMs` fall back to the top-level values of the same name, and
`readyTimeoutMs` then to the backend default below. A profile's idle delay is
read when a countdown is armed, from the profile the session's sandbox runs
on.

| Profile field     | Backend               | Default                       | Meaning                                                                                      |
| ----------------- | --------------------- | ----------------------------- | -------------------------------------------------------------------------------------------- |
| `backend`         | all                   | required                      | `docker`, `kas`, or `buildkite`                                                              |
| `idleMs`          | all                   | top-level `idleMs`            | Idle delay before this profile's sandboxes hibernate                                         |
| `image`           | `docker`, `buildkite` | matching release tag          | Runner image                                                                                 |
| `binary`          | `docker`              | `docker`                      | Docker-compatible command                                                                    |
| `controlPlaneUrl` | `docker`, `buildkite` | `host.docker.internal`        | `DSH_YAWN_CONTROL_PLANE_URL` runners dial, `ws://` or `wss://`                               |
| `namespace`       | `kas`                 | `dsh-yawn`                    | Namespace containing claims and warm sandboxes                                               |
| `warmPool`        | `kas`                 | `dsh-yawn-universal`          | Warm pool used for claims                                                                    |
| `readyTimeoutMs`  | `kas`                 | top-level, or 3 min           | How long to wait for a claimed sandbox                                                       |
| `kubeconfig`      | `kas`                 | normal client lookup          | Optional kubeconfig path                                                                     |
| `organization`    | `buildkite`           | required                      | Buildkite organization slug                                                                  |
| `pipeline`        | `buildkite`           | required                      | Pipeline slug whose job runs the runner                                                      |
| `controlPlaneUrl` | `buildkite`           | required                      | `DSH_YAWN_CONTROL_PLANE_URL` runners dial; agents are never local                            |
| `readyTimeoutMs`  | `buildkite`           | top-level, or 10 min          | How long a build may wait for an agent                                                       |
| `secretKey`       | `buildkite`           | `DSH_YAWN_REGISTRATION_TOKEN` | Cluster secret holding the registration token; see [Registration token](#registration-token) |

A Buildkite profile cannot hibernate, so it checkpoints on idle (see below).
The API token, with `read_builds`, `write_builds`, `read_pipelines`,
`read_secrets_details`, and `write_secrets`, resolves
per Buildkite request, so a changed token reaches the next call without a
restart:

1. the credential stored for the profile, entered on **Settings → Sandboxes**
   through the write-only credential API. It lives in the host credential
   document (`$DSH_HOME/.credentials.yaml`) under a name derived from the
   profile — `DSH_YAWN_BUILDKITE_<PROFILE>_TOKEN` — so two Buildkite profiles
   keep two tokens, and it never reaches a sandbox.
2. `BUILDKITE_API_TOKEN` in the control plane's process environment, the
   deployment-managed fallback.

A profile whose token resolves nowhere does not stop the host: it is named once
in the log at boot, and its sessions fail at their first prompt with the
setting to fix.

For each session, a Buildkite profile:

1. looks for a live build tagged with the session, in case the host restarted
   after creating one but before saving the record;
2. otherwise writes the registration token into the pipeline cluster's secret
   (see [Registration token](#registration-token)), failing the session with
   the reason if the write fails;
3. creates a build on branch `main` — Buildkite requires one, and the step skips
   checkout, so it is only a label — with `DSH_YAWN_SANDBOX_ID`,
   `DSH_YAWN_CONTROL_PLANE_URL`, and `DSH_YAWN_RUNNER_IMAGE` in the build
   environment;
4. waits for the build to be `running`, then up to 60 seconds for the runner to
   register, and cancels a build that has not started within
   `readyTimeoutMs`.

The sandbox ID is `dsh-<16 hex chars>-<6 random hex chars>`. The random suffix
changes on every build, so a runner from a cancelled job cannot be mistaken for
a new one. The pipeline shape and the limits are described in
[`docs/runners/buildkite.md`](https://github.com/zhming0/dsh-yawn/blob/main/docs/runners/buildkite.md).

### Archived sessions

Archiving a session in the Web UI is one-way: dsh keeps the session log but
offers no unarchive, so the session can never run again. When the host's
workspace registry reports an archived session, this control plane destroys that
session's sandbox — container or claim, workspace storage included — and drops
its record, instead of holding both until `expiresAfterMs`. Subagent sessions
share the root session's sandbox, so releasing the root releases the whole
subagent tree; the children could not resume afterward anyway, because the
sidebar hides subagent-origin sessions. Commit and push work you still need
before archiving; the release also waits out a turn that is still running,
whatever session in the tree opened it. Outside the Web profile no workspace
registry exists, and sessions stay on the ordinary idle and expiry path.

A session in the [Scratch Workspace](#the-scratch-workspace) has no repository
and skips the rest of this lookup. For a Web Workspace created by this package,
the repository URL stored in its anchor takes precedence. Other sessions use
`repository` when set, then run `git remote get-url origin` in their host
working directory. That fallback auto-detection needs a local checkout;
repository Workspaces do not.

Workspace anchors live beneath `stateDir/workspace-anchors`. Each contains only
`repository.json`; file and command tools map the host anchor to `workspace`
inside the sandbox. Anchors remain after sandbox expiry so historical dsh
Workspace registrations do not become missing directories.

Each release publishes a runner image tagged with the same version as this
package, and the control plane defaults to that exact tag, so a profile's `image`
only matters when testing a locally built image. A Buildkite profile passes it
to the build as `DSH_YAWN_RUNNER_IMAGE`; the pipeline step runs that image.

### The Scratch Workspace

The Scratch Workspace is for work that needs no repository. Its host directory
is `stateDir/scratch`. Each of its sessions gets its own sandbox, like any
other session, but nothing is cloned and no `.agents/setup` runs: `workspace`
starts empty, and the model is told it works in an empty directory rather than
a checkout. Neither `repository` nor `git remote get-url origin` is consulted.

It is always available to start a session in. The `sandbox-scratch-workspace`
row registers it every time the control plane boots, so an installation that
predates it gets it on its next start, and a fresh installation opens with a
blank session in it. It cannot be deleted: the sidebar still shows **Delete
workspace**, because dsh shows that action on every Workspace, but the delete
dialog answers with an error. It can be renamed, and a rename survives
restarts.

It has no settings scope of its own: its sessions get the global secrets and
the global AGENTS.md layer only, and it does not appear on the Secrets or
Instructions pages. On a backend that checkpoints, a sleep keeps only its
artifacts folder; see [Idle and hibernation](#idle-and-hibernation).

### Sandbox profiles

`profiles` is a map from profile name to a backend and that backend's
settings. A Kubernetes host with two pod sizes looks like this; each warm pool
must exist in the cluster (see [Several pools](../docs/runners/kubernetes.md#several-pools)):

```yaml
- id: sandbox-manager
  config:
    defaultProfile: standard
    profiles:
      standard:
        backend: kas
        warmPool: dsh-yawn-universal
      large:
        backend: kas
        warmPool: dsh-large
```

Profiles may mix backends, for example one Docker profile beside Kubernetes
ones. Every session record stores the profile name and backend it was
provisioned with. Removing a profile — from the configuration or at runtime
through the settings — keeps its existing sessions readable, but they cannot
wake until a profile with that name is restored on the same backend. A
session whose pending choice was removed falls back to an error at its first
prompt, asking the user to pick again.

With an empty map the host still boots, and sessions, history, secrets,
instructions, and repository workspaces all keep working; only provisioning
fails, and its error names the missing setting. Add a profile — in the
`sandbox-manager` settings layer or through the Web Sandboxes page — then
send the prompt again.

### Idle and hibernation

After `idleMs` without a turn (the profile's own, else the top-level one) the
session's sandbox is put away and the
`expiresAfterMs` countdown starts. What "put away" means depends on the
backend:

- Docker and Kubernetes hibernate: compute stops, the workspace stays, and the
  next prompt wakes the same sandbox. Docker starts the container it stopped,
  so its whole filesystem is still there and the repository's setup does not
  run again. Kubernetes builds a new pod around the surviving workspace volume:
  a new machine, so the repository's setup runs again on it and puts back the
  system packages the repository declares.
- A backend that cannot hibernate checkpoints instead. The manager commits the
  Git working tree inside the sandbox (as `dsh <dsh@localhost>`, only if there
  are changes), writes the commits that `origin`'s default branch does not
  have to a Git bundle (a file Git can restore commits from), stores that
  bundle under `stateDir/checkpoints/` on the host, tars the artifacts folder
  alongside it, and then destroys the sandbox. Nothing is pushed. The next prompt
  provisions a fresh sandbox, clones and runs `.agents/setup` as for a new
  session, unpacks the bundle, checks the original branch out at the saved
  commit, undoes the checkpoint commit so the changes are uncommitted once
  more, and unpacks the artifacts tar. The checkpoint files are deleted once
  the restore succeeds.

The one path outside the checkout that survives either kind of sleep is the
session's artifacts folder, `/workspace/artifacts/`. It holds output the user
should keep that does not belong in the repository — screenshots, recordings,
reports. It sits on the workspace volume beside the checkout, so a capture
never becomes an untracked file, a hibernation keeps it, and a checkpoint
carries it into the machine it rebuilds. Nothing else outside the checkout
survives both.

A checkpoint keeps the checked-out branch, its commits (pushed or not), every
tracked or untracked file that is not ignored, and the artifacts folder. It
does not keep ignored files, installed packages, anything else outside the
repository, other local branches, stashes, or which changes were staged:
everything comes back unstaged. A merge or rebase that was stopped on conflicts
comes back as the conflicted files with their markers, no longer mid-merge.
`.agents/setup` runs before the restore, on the configured revision, as it does
for a new session, so the repository's own tools are back by the time the
session's tree is. The first prompt after a restore carries a notice that says
the sandbox was recreated: the Git changes and commits are back, the
repository's setup ran before the restore so project steps may need re-running,
anything the model installed itself and every ignored file are gone, and
previously staged changes are now unstaged. A restore that had to leave the
artifacts folder behind says so on that notice.

A wake carries its own one-shot notice on the first prompt, worded for what the
machine kept. On Kubernetes the new pod kept only the workspace volume, so the
notice names running processes, `/tmp`, and anything the model installed itself
as gone; the home directory and the repository's tools both come back with it,
because the new machine runs `.agents/setup` again. On Docker the files
survived, setup does not run again, and the notice says only that the processes
did not. Only a backend that hibernates sends this notice: a backend that
checkpoints never wakes, so its first prompt after a restore is the only one
that carries a note.

The bundle and, when the session had one, the artifacts tar live in the host's
state directory next to the credential store, with the same file permissions,
so a checkpoint has the same exposure as a hibernated sandbox's disk and needs
no write access to the repository. The bundle only carries commits the remote's
default branch does not have; when the clone has no `origin/HEAD` it carries
the whole history instead. A bundle over 64 MiB fails the checkpoint. An
artifacts tar over 64 MiB, or one that cannot be made, is left behind instead:
the Git work still checkpoints, and the restore notice says the folder did not
come back.

If the Git save fails the sandbox stays up, the host logs a warning, and the
idle timer retries after another `idleMs`; a failed artifacts save only logs
the warning and leaves the folder behind. If the restore fails, the new sandbox
is destroyed and the next prompt tries again from the same checkpoint files; a
bundle that was removed from the state directory produces an error on every
prompt until the session is released. A session that expires while
checkpointed loses its checkpoint files with its record.

The session record says "checkpointed" from the moment the checkpoint files are
on host disk until a fresh sandbox has been provisioned and restored. A host
crash inside either window therefore keeps the work: the next prompt restores
from the checkpoint files. The cost is a sandbox the host no longer knows
about, the one it was about to destroy or the one it was restoring into. Only
the backend's own limits, such as a job timeout, reclaim it.

A session in the [Scratch Workspace](#the-scratch-workspace) has no repository,
so its checkpoint has no Git half: its working directory has no remote copy to
diff against, and carrying it would mean carrying all of it, ignored files and
all. Its checkpoint is the artifacts folder alone, under the same 64 MiB cap.
The environment section tells the model this in advance on such a backend, and
the restore notice says that only the artifacts folder came back. Hibernation
keeps the whole workspace, as for any session.

The Buildkite backend checkpoints; Docker and Kubernetes hibernate.

### Search

The stock `@deepseek-ai/dsh-tool-fs-search` plugin supplies `glob` and `grep`,
so their caps are that package's settings, set where the plugin is mounted. In
the Web UI that is the agent preset, not this profile layer: shipped presets
restate the plugin by its stock name, and a preset copied from one carries the
same settings to edit.

### AGENTS.md instructions

The Web UI's **Settings → Instructions** page stores model guidance without
modifying a repository:

- **Global · All workspaces** applies to every session managed by this host.
- **Workspace · owner/repo** adds guidance only when that repository Workspace
  is selected. Workspace guidance takes precedence over the global layer.
- Checked-in `AGENTS.md` files still load normally. More-specific nested files
  take precedence when the agent works below their directory.

The current complete UI-managed baseline is added to durable model context on
the next model request, usually after the next user message or tool call. It
does not alter a request already in flight. If a setting changes, the new
baseline explicitly supersedes the previous one; clearing the last active
layer adds a corresponding removal notice. Literal `</system-reminder>` text
is escaped inside the control plane-owned frame.

State is stored in the owner-only `stateDir/instructions.json` file, not in a
checkout. Global plus workspace content is limited to 65,536 UTF-8 bytes for
each effective workspace. Removing and later re-adding a Workspace with the
same normalized repository URL restores its saved layer.

## Secrets

Secrets and tokens never go in YAML, because a profile layer is a plain file
and a chat transcript is durable. They go through the Web UI's
**Settings → Secrets** page, which stores them in the secret store file under
`stateDir`.

The page lists every secret name, grouped by scope: Global, then each
Workspace that has secrets. **Add secret** picks the scope (the stock settings
shell has no per-workspace pages), and **Replace** sets a new value for an
existing name. Global secrets reach every sandbox. A workspace secret
reaches that workspace's sandboxes and overrides a global secret of the same
name; a sandbox receives exactly the global set with its workspace's
overrides applied. Scoping limits which sandbox receives a value — one control
plane still lets every admitted user reach every sandbox, and global secrets
reach every sandbox.

The Buildkite API token is the one control-plane-owned token the UI also
stores: **Settings → Sandboxes** writes it, write-only, to the host credential
document (`$DSH_HOME/.credentials.yaml`). That document is host-side and never
pushed to a sandbox, which is what keeps this token out of the secret store
that runners receive.

The control plane reloads the secret store file before the next sandbox command, so a
saved change takes effect without restarting dsh.

A secret named `GITHUB_TOKEN` doubles as the Git credential for github.com, so
storing a fine-grained personal access token (or `gh auth token`) under that
name is the simplest way to reach private repositories — no OAuth app
required. A workspace-scoped `GITHUB_TOKEN` serves that workspace's clones in
place of the global one.

Sandbox code can read injected secrets, which is their purpose. The store
improves storage and cleanup, not confidentiality from the repository being run.
Skip `GITHUB_TOKEN` entirely if you only work on public repositories.

On the Kubernetes distribution the same store lives on the control-plane pod's data
volume; [`docs/credentials.md`](../docs/credentials.md) is the install-facing
page, including the credentials that deliberately never enter this store.

## Credentials at rest

Provider state belongs on the dsh host, not in a sandbox. Files in `stateDir`
are created with owner-only permissions. The runner receives current values in
memory before it starts a command. Git credentials are served through a Unix
socket and are never written to the workspace.

## Tunnel

Runners reach the host by opening a WebSocket at `/tunnel` on the tunnel
listener (`tunnel.port`, default 8081). The upgrade request carries the
registration token as a bearer token and the runner's sandbox ID in the
`X-Dsh-Sandbox-Id` header; the host answers a refusal with a plain HTTP
status (401 bad token, 409 sandbox already registered) and an acceptance with
101, after which the WebSocket carries HTTP/2 with the roles reversed: the
host is the HTTP/2 client and the runner the server. `GET /healthz` on the
same port answers 200 so an HTTP load balancer can health-check it.

The listener itself is plaintext. A runner on a trusted network, such as a
Kubernetes sandbox in the host's cluster, dials it directly with
`ws://host:8081/tunnel`. A runner that reaches the host over a network you do
not control must dial `wss://`, with TLS terminated by the same HTTPS proxy or
Ingress that fronts the Web UI: route one path (`/tunnel`) of that hostname
to the tunnel port and hand runners `wss://<hostname>/tunnel`. No second
certificate, port, or listener is involved, and the proxy's authentication
layer must not sit on that path; the registration token is the tunnel's
authentication. Runners trust the system CA bundle, so a private CA has to be
made available to the runner process, for example through `SSL_CERT_FILE`.

When the tunnel must not share the UI's listener, a TCP proxy that terminates
TLS on a port of its own, such as nginx `stream` or HAProxy, works too.
Runners then dial `wss://<hostname>:<port>/tunnel`.

Every proxy on the path must pass WebSocket upgrades and keep a connection
open for as long as a session lasts. Idle timeouts are satisfied by the
host's HTTP/2 pings every 30 seconds, but a maximum connection lifetime is
not: when the proxy cuts the tunnel, the RPC in flight fails and the runner
redials within seconds. Raise such limits to hours where the proxy has them.

## Previews

A server started inside a sandbox — a dev server, a docs build — is reachable
from the browser at its own origin when `preview.domain` names a domain the
control plane's preview listener answers for:

```
<sandboxId>-p<port>.<preview.domain>
```

One DNS label per sandbox and port, so one wildcard certificate covers every
preview of an install, and each preview is a real origin: absolute-path
assets, storage, cookies, and service workers all work, and nothing the page
does can reach the Web UI's origin around it. The listener is deliberately
not the tunnel port (sandboxes can reach that one) and not the Web UI's
server (dsh's web server matches routes by path, so a subdomain request would
land in the SPA fallback); it is a third listener, fronted by whatever fronts
the UI. Since a preview URL carries no port, that front door has to serve the
UI and `*.preview.domain` on the same scheme and default port — a browser
asks for whatever the UI's own page used, so previews and the UI cannot sit
on different ports behind it. Requests are relayed over each runner's
registered tunnel — the runner dials `127.0.0.1:<port>` and never learns the
public host name — and a preview request counts as session activity,
re-arming the idle countdown, so a page that keeps making requests does not
hibernate under its viewer. A page that loads once and then sits idle makes
no further requests, and the sandbox hibernates as usual.

**Do not publish the preview listener yet.** The relay forwards the browser's
headers to the sandbox, cookies included, because the previewed app's own
session has to work — but that also carries whatever authenticates the
wildcard host into untrusted sandbox code. `preview.authCookieNames`, which
drops configured auth-cookie names from the request before it enters the
tunnel, is not implemented yet; keep previews on a development host until it
lands. For the same reason, the listener binds `0.0.0.0` by default: on the
Kubernetes backend the reference NetworkPolicy lets sandbox egress reach only
the tunnel port, so a sandbox cannot dial it, but on the Docker development
path the sandboxes share the host's network and can. Set `preview.bind` to
`127.0.0.1` when the preview port is not meant to be reachable from the
network.

The Sandbox tab links the sandbox's listening ports (the runner reports them)
and its preview address, each opening in a browser tab. The sandbox
environment prompt tells the model the address pattern once its sandbox
exists, so it can start a server detached and hand the user a clickable URL.
Without a `preview.domain` the Sandbox tab's preview area says previews are
not configured.

## Registration token

A runner authenticates its tunnel with a registration token, presented in the
connection handshake. Nothing outside supplies it: the control plane generates
it on first boot and keeps it at `stateDir/registration-token` with owner-only
permissions. Later boots reuse it, so sandboxes started before a restart still
register after it.

Each backend delivers it:

- **Docker** passes it to every container it starts as
  `DSH_YAWN_REGISTRATION_TOKEN`.
- **Kubernetes** stores it in the `dsh-yawn-registration-token` Secret the
  warm pool's pods mount. The control plane owns that Secret: it creates it
  when missing and patches it otherwise, so `helm upgrade` and GitOps syncs
  cannot reset it.
- **Buildkite** stores it in the pipeline cluster's
  `DSH_YAWN_REGISTRATION_TOKEN` secret (`secretKey` changes the name), created
  with an access policy for that pipeline. The pipeline maps the key into the
  job, so the value never appears in the build environment. Keys are unique
  per cluster and an existing secret keeps its access policy, so give each
  pipeline in a cluster, and each control plane sharing a cluster, its own
  `secretKey`.

Each backend writes its secret before it starts a sandbox: Kubernetes before
every claim and wake, Buildkite before every new build. Writing every time
puts back a secret someone deleted. If the write fails, that session fails
with the reason instead of waiting out the ready timeout, and the next session
tries again.

A Kubernetes pod reads the Secret only when its container starts, so a write
reaches pods that start after it. Until the Secret exists, the warm pool's
pods wait with `CreateContainerConfigError` and the kubelet retries them. So
the Kubernetes backend also writes as soon as it is created, at boot or when
its profile is added or changed, and the pool can fill before the first
session; a failure there is only logged.

There is no rotate button. To replace a leaked token, delete
`stateDir/registration-token` and restart the control plane. It generates a new
token and stores it as described above. The old token stops working at once: a
running sandbox keeps its connection but cannot reconnect, a hibernated Docker
container cannot wake, and Kubernetes warm pods that booted with it cannot
register until they are recycled. A hibernated Kubernetes sandbox is fine,
because waking starts a new pod that reads the new Secret. On the Helm chart:

```sh
kubectl -n dsh-yawn exec deploy/dsh-yawn-control-plane -c control-plane -- rm /data/.dsh-yawn/registration-token
kubectl -n dsh-yawn rollout restart deploy/dsh-yawn-control-plane
kubectl -n dsh-yawn rollout status deploy/dsh-yawn-control-plane
kubectl -n dsh-yawn delete sandbox -l agents.x-k8s.io/warm-pool-sandbox
```

## Limits

- The subprocess implementation translates a path argument only when it is a
  whole argv
  element under the session workspace. A session-frame path embedded in a
  `--flag=value` pair reaches the sandbox untranslated.
- Streaming subprocess input is not implemented: one-shot stdin, streamed
  stdout/stderr, cancellation, and background process handles are supported,
  and interactive terminals allocate their own PTY rather than using it.
- An interactive terminal lives and dies with its sandbox. Idle hibernation,
  expiry, and a host restart end every open terminal; its screen buffer on the
  host is the only part that survives a browser reload. While a shell is
  running the provider reports `unknown` activity — proving a prompt needs
  shell integration the runner does not have — so unattended cleanup cannot
  reclaim a live-but-quiet terminal; once the session is gone the provider
  reports `idle` and cleanup can. Explicit close and session disposal always
  work.
- Shell and subprocess output is kept in bounded in-memory tails. Truncated
  output is reported, but it is not copied to a spill file.
- An uploaded attachment reaches the sandbox through one unary `WriteFile` RPC
  that both sides buffer in memory, so copies are capped at 64 MiB per file. A
  larger upload keeps dsh's "cannot access a readable path" placeholder;
  chunked transfer is not implemented.
- Docker stop/start keeps the same container. Kubernetes suspension removes the
  pod and keeps its workspace volume.
- The Sandbox tab reads memory and CPU from cgroup v2. A v1 host falls back to
  the machine's totals, which overstates a container that is limited below
  them. A session restored from a checkpoint reports the fresh sandbox's start
  time, not the one it replaced.
- Previews relay plain HTTP request/response exchanges; WebSocket upgrades
  through a preview are not implemented yet, so dev-server hot reload does
  not connect. See Previews above.
- Turn notifications are a page feature: the page must stay open (a background
  tab is fine), the browser exposes the Notifications API only in a secure
  context (https, or localhost), and a frozen background tab can delay a
  notification until the browser wakes it. On iOS, only Safari exposes the API
  (16.4+, and to a page added to the Home Screen); Firefox and Chrome there
  cannot show notifications on any page.
