# End-to-end testing

Use this guide to validate what unit tests cannot cover: the control plane
talking to a real runner, lifecycle behavior in Docker and Kubernetes, and a
model driving sandbox tools through the dsh Web UI. The automated checks to run
first are listed in [`AGENTS.md`](../AGENTS.md#test-the-affected-path).

| Layer                   | What it proves                                                                           | Needs                                 |
| ----------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------- |
| Docker smoke test       | Runner registration, RPC, tools, setup, hibernate/wake, persistence                      | Docker                                |
| Kubernetes E2E test     | Real images, dial-out RPC, reconnect, warm adoption, suspend/resume, persistence, expiry | Docker, kind, kubectl, Python 3       |
| Browser acceptance test | dsh Web, workspace creation, model-to-sandbox tools, settings persistence                | Docker, a browser, a model credential |

CI runs both smoke tests on every pull request. Run the one your change affects
locally while developing. Never put a model credential's value in the
repository, a command transcript, a fixture, or a manifest.

## Docker lifecycle smoke test

```sh
docker buildx bake dev --load
pnpm build
pnpm test:docker
```

It checks runner registration over the tunnel, secret delivery, the bundled
tools, sudo, `.agents/setup` running once per machine, and that hibernate/wake
keeps the machine's setup marker, workspace, home directory, and mise tools.
`DSH_YAWN_RUNNER_IMAGE=<tag>` tests another local image. Success ends with:

```text
PASS: Docker runner registration, tools, setup, and hibernate/wake
```

The script removes its container on exit. If an interrupted run leaves one
behind, inspect it before removing it.

## Kubernetes transport and lifecycle test

```sh
docker buildx bake dev control-plane-dev --load
pnpm test:kas
```

It creates the disposable `dsh-kas-e2e` kind cluster with the pinned
agent-sandbox controllers and runs the production `TunnelServer` and
`KasBackend` as a Job that real warm runner pods dial. It checks warm adoption,
RPC, secrets, the rootless Docker sidecar, sudo, hibernate/wake with setup
rerunning on the new machine, suspend/resume persistence, and expiry. The sudo
probe stays off the network, because kind's default CNI does not enforce the
NetworkPolicy rule that lets sandbox pods reach DNS. Success ends with:

```text
PASS: Kubernetes runner registration, RPC, reconnect, and hibernate/wake
PASS: agent-sandbox warm adoption, suspend/resume persistence, and expiry
PASS: Kubernetes agent-sandbox transport and lifecycle
```

On failure it prints objects, pod descriptions, and logs, then removes the
cluster. `KEEP_KAS_CLUSTER=1 pnpm test:kas` keeps it;
`scripts/kas/teardown.sh --name dsh-kas-e2e` removes it later.
`DSH_YAWN_KAS_CLUSTER_NAME`, `DSH_YAWN_RUNNER_IMAGE`, and
`DSH_YAWN_CONTROL_PLANE_IMAGE` override names and image tags.

### Inspectable development cluster

For a cluster that stays up between runs, build both images, start a `kind`
cluster with the sandbox pool, and run the smoke test:

```sh
docker buildx bake dev control-plane-dev --load

scripts/kas/dev-cluster.sh \
  --runner-image dsh-yawn-runner:dev \
  --control-plane-image dsh-yawn-control-plane:dev \
  --load-runner-image

scripts/kas/smoke-test.sh --namespace dsh-yawn
scripts/kas/teardown.sh
```

Omit `--control-plane-image` to run dsh outside the cluster and pass
`--control-plane-url ws://<host>:8081/tunnel` instead. Either way the control
plane writes the `dsh-yawn-registration-token` Secret once it has a `kas`
profile, and warm pods cannot start until it does, so start an outside control
plane with that profile before the script waits for warm capacity, or pass
`--skip-warm-pool`. Use `--name NAME` on both cluster scripts to choose a
different kind cluster name.

The smoke test verifies warm-pod adoption, suspend/resume persistence,
workspace and home-directory survival, the rootless Docker sidecar, and expiry.
A closed tunnel does not return a sandbox to the warm pool: an adopted pod is
not recycled, and the pool creates a new one after adoption.

## Browser and model acceptance test

Run this for changes to dsh integration, tool routing, workspace setup,
credentials, settings, or Web UI contributions. It runs against a disposable
control plane started from the checkout, with Docker sandboxes.

### Start a session

1. Build the runner image with `docker buildx bake dev --load`, or pass a
   published tag with `--runner-image`.
2. Run `node scripts/dev.mjs start` with `DEEPSEEK_API_KEY` in its
   environment; the default model reads it from there. It stays in the
   foreground and prints the tokenized `dsh web` URL. It uses a scratch
   `DSH_HOME`, so a control plane you use elsewhere is not touched. See
   [`development.md`](development.md#running-from-a-checkout-laptop--docker)
   for what it sets up.
3. Open the URL with `agent-browser` (see the `using-agent-browser` skill). A
   fresh control plane opens on an **Internal Testing Notice**; dismiss it with
   **Continue**.
4. Add a disposable public repository as a Workspace by its URL. This creates
   the session bound to it in the same step.

What happens next depends on the feature under test. For a change to tool
routing, ask the model to use its shell and file tools to print `uname -a` and
the working directory, read a known file from the repository, and write a
uniquely named file with known content and read it back.

### Collect evidence from the sandbox

A chat answer alone is not evidence that a tool ran in the sandbox. Read the
sandbox directly:

```sh
docker ps -a --filter label=dsh.session --format '{{.ID}}\t{{.Names}}\t{{.Label "dsh.session"}}'
docker exec <container> cat /workspace/repository/<file>
```

The model's hostname must be the container's ID, not the host's name, and the
file must contain the expected text. Secrets are the exception: the runner
injects them into session commands only, so `docker exec` cannot see them.
Assert their effect from the host (a file, a git remote) and their values from
the tool output. Do not paste `docker inspect` output into a transcript; its
environment carries the registration token.

For a UI change, a screenshot alone does not prove persistence or
model-context injection. Exercise the interaction and check the resulting
state.

### Clean up

Stop the control plane with Ctrl-C, then run `node scripts/dev.mjs clean`. It
removes the sandboxes the run created, which outlive the control plane. A later
`start` does the same before it replaces the scratch home.

### Kubernetes variant

Changes to the control-plane image, the chart, or the Kubernetes backend need
the same test against a cluster. Create the
[inspectable development cluster](#inspectable-development-cluster) (not
`pnpm test:kas`, which removes its cluster), supply the model credential through the provider's host
configuration, and forward the server:

```sh
kubectl -n dsh-yawn port-forward deploy/dsh-yawn-control-plane 3000:3000
```

Open `http://localhost:3000/launch-token` when the control plane runs with
`DSH_YAWN_CONTROL_PLANE_LAUNCH_TOKEN_ROUTE=1` (the oauth2-proxy patch sets it);
otherwise take the token from `kubectl -n dsh-yawn logs
deploy/dsh-yawn-control-plane | grep 'dsh web:'`. Restart the port-forward
after a rollout; it does not follow the replacement pod.

In addition to the steps above, ask the model to run
`docker run --rm -v "$PWD:/src" alpine sh -c 'echo <content> > /src/<file>'`.
Read the evidence from the runner container:

```sh
kubectl -n dsh-yawn get sandboxclaims,sandboxes,pods
kubectl -n dsh-yawn exec <pod> -c runner -- cat /workspace/repository/<file>
kubectl -n dsh-yawn exec <pod> -c docker -- docker images
```

The hostname must be the Sandbox pod, and the file the container wrote must be
owned by UID 1000 in the runner, because rootless Docker maps container root to
the sidecar's user.

## Feature scenarios

Run the scenario for the feature you changed, on top of a session started as
above. To change the `sandbox-manager` row on the checkout control plane, use
its Web settings form; the write lands in the scratch profile, and the next
`start` resets it.

### UI-managed instructions

For changes to the Instructions page or model-context injection:

1. Open **Settings → Instructions** and save a distinctive Global instruction.
2. Select the test Workspace and save a different workspace instruction.
3. Switch between both scopes and confirm their values remain independent.
4. Close and reopen Settings and confirm both values persisted.
5. Send a new model request and verify its behavior reflects both layers, with
   the workspace instruction taking precedence where they conflict.
6. Empty each scope and save to clean up.

The settings must persist outside the repository checkout. Confirm the test did
not create or modify an `AGENTS.md` file in the Workspace.

### Sandbox profile selection

For changes to profiles, provisioning, or the composer chip. Give the
`sandbox-manager` row two Docker profiles that differ only by name, for
example `standard` and `large`, both with `image: dsh-yawn-runner:dev`.

1. Start a new session and confirm the profile chip is visible in the
   composer's tool row and shows the default profile. It must be absent when
   only one profile is configured.
2. Pick the other profile and reload the page; the chip must still show it.
3. Send a prompt that uses the shell. Before that prompt there must be no
   sandbox for the session (`docker ps`); after it there must be exactly one,
   and `stateDir/sessions.json` must record the picked profile on the session,
   with no entry left in `pendingProfiles`.
4. Confirm the chip is now disabled and keeps showing the picked profile.

### PTC mode

For changes to the PTC channel, the `ptc-runtime` row, or the bootstrap the
runner image ships. The Docker smoke test already drives a run through the
channel; this scenario proves the whole path from a session.

1. Start a session, open the composer's preset picker, and select **ptc**.
2. Ask the model to use `run_code` to print the sandbox's hostname and working
   directory, and to write a uniquely named file and read it back.
3. The tool result must show the sandbox's hostname, not the host's. From the
   host, `docker exec <container> cat /workspace/repository/<file>` must show
   the same content, and
   `docker exec <container> ls -l /opt/dsh-yawn/ptc-runtime-node/process.js`
   must show the bootstrap the image ships.

### Sandbox web previews

For changes to the preview listener, the relay, or the preview surfaces. Give
the `sandbox-manager` row a `preview.domain`; the listener routes by the `Host`
header alone, so nothing needs to resolve it. `preview.localhost` works well,
because browsers resolve `*.localhost` to loopback. The listener's port is the
`preview.port` setting, default 8082.

Preview links carry no port, since a deployment serves the UI and previews on
one front door, and the address given to the model is always `https://`. On a
development host, either bind the listener to port 80 (`preview.port: 80`) or
launch Chrome with `--host-resolver-rules='MAP *.localhost 127.0.0.1:8082'`,
and swap the scheme of the model's address by hand.

1. Ask the model to start a detached web server in the sandbox on a fixed
   port. The Sandbox tab must list the port under "Listening ports" as a link
   that opens the page in a browser tab; the "Web preview" row links the
   sandbox's base address.
2. The model's reply should carry the preview URL; the sandbox environment
   prompt names the address pattern once the sandbox exists.
3. The opened page is a normal top-level tab: absolute-path assets load, and
   `localStorage` works from its console.
4. From the host, `curl -H "Host: <sandboxId>-p<port>.<preview.domain>"
http://127.0.0.1:<preview.port>/` must return the same page;
   `curl -H "Host: other.example.com" …` must return 404, and a hibernated
   sandbox must answer 503 with the wake hint.
5. With `preview.domain` removed, the Sandbox tab must say previews are not
   configured.
6. A preview page that keeps making requests past the idle delay must keep
   the sandbox awake. Once the requests stop, it hibernates after the idle
   delay.

### Web plugin management

For changes to the Plugins page, the bundle patch, or `dsh-yawn-seed`. Step 3
needs the Kubernetes variant, because the seed runs in the control-plane
image.

1. The sidebar's **Plugins** page must list the official bundles the
   installation ships switched off, the official plugins that carry a
   configuration page, and `@zhming0/dsh-yawn` under **Installed**, switched
   on.
2. Pack a package that declares a bundle patch (`dsh.bundle.patch` naming a
   `cordis.patch.yml`), install it with **Add plugin** by absolute path, then
   **Enable now**. The page must list it switched on, and the profile's
   `package.json` must gain the dependency and the bundle entry
   (`/data/.dsh/profiles/web/package.json` in the control-plane pod).
3. Roll the control plane onto a new image version (for a development build,
   remove the version marker first, as the troubleshooting note below says).
   After the restart the plugin must still be installed and switched on.
4. Uninstall the test plugin from its page. The dependency and the bundle
   entry must be gone, and a restart must come up without it.

## Troubleshooting

- **Docker is unavailable:** report that the Docker, Kubernetes, and browser
  layers were not run. Unit tests do not substitute for them.
- **Docker smoke imports fail:** run `pnpm build`; the script imports
  `control-plane/dist`.
- **A browser tool call fails while direct runner health succeeds:** compare
  package resolution in the control plane with the control-plane and runner
  logs; dsh plugins must share the control plane's in-box package instances.

On Kubernetes:

- **A development image does not reflect the checkout:** rebuild with
  `docker buildx bake dev control-plane-dev --load`, then rerun
  `dev-cluster.sh` with `--load-runner-image`.
- **A rebuilt control-plane image still runs the old bundle:** `dsh-yawn-seed`
  refreshes the profile only when the image version changes, and every
  development build is `0.0.0-dev`. Remove the marker and restart; the next
  boot merges the image's manifest fields and runs
  `pnpm update @zhming0/dsh-yawn`, keeping the profile's other plugins:
  `kubectl -n dsh-yawn exec deploy/dsh-yawn-control-plane -c control-plane -- rm /data/.dsh/profiles/web/.dsh-yawn-image-version`,
  then `kubectl -n dsh-yawn rollout restart deploy/dsh-yawn-control-plane`.
- **Plugins disappeared after a control-plane upgrade:** the refresh failed,
  and the pod log says so. The previous manifest is kept at
  `/data/.dsh/profiles/web/package.json.before-reseed`, and the next boot
  merges it back and retries. To recover by hand, copy it over `package.json`
  in the profile and run `pnpm install` there.
- **The warm pool never becomes ready:** inspect the agent-sandbox controller
  deployments, the `dsh-yawn-universal` `SandboxWarmPool`, and runner pod
  events.
- **The browser stops loading after a rollout:** restart the port-forward.
