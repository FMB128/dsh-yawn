# FAQ

### What does the quick-start command do?

The [README's quick start](../README.md#quick-start) runs the control plane in
one Docker container and starts sandboxes as sibling containers through your
Docker daemon.

- The Docker socket mount lets the control plane start sibling sandbox
  containers. The image's entrypoint joins the socket's group and drops root
  before dsh starts, so the command needs no `--group-add` and no host-side
  group lookup.
- `DSH_YAWN_BIND_ALL=1` makes dsh listen on the container address so the
  published port reaches the Web UI. `DSH_YAWN_PASSCODE` is the passcode login;
  the image refuses to start without a sign-in mode.
- The sandbox profile needs only `backend: docker`: the runner image defaults
  to the tag matching the control plane, and runners dial back through
  `host.docker.internal` on the published tunnel port 8081.
- The Web UI's edits persist into `/data/.dsh/profiles/web/cordis.patch.yml`
  inside the container if you would rather edit them directly.

### How do users sign in?

Set `DSH_YAWN_PASSCODE` (Docker) or `auth.passcode` (Helm), open the control
plane's address, and enter the passcode. The control plane serves `/login` and,
after a correct passcode, completes dsh's own token exchange on the server. The
launch token never reaches the browser, and the dsh cookie lasts 30 days, so a
browser signs in once.

The Helm chart can use OIDC instead: set `auth.mode=oidc` and configure
`auth.oidc.issuer`, `clientId`, and an email or domain allowlist. The control
plane runs the authorization code flow itself; there is no oauth2-proxy sidecar.

`email_verified: false` or a missing claim is accepted by default; set
`auth.oidc.allowUnverifiedEmail=false` if the issuer must assert `true`.

The `/launch-token` route has been removed, and `?token=` on the index is
refused in both modes. dsh's launch token still exists inside the process as the
credential its cookie minting needs; users never see or provide it.
Details: [`control-plane.md`](control-plane.md#expose-the-web-ui).

### What is a sandbox's lifecycle like?

```text
new session -> start sandbox -> clone and set up repository -> run tools
                                                            |
                                                            v
follow-up <- wake with the same /workspace <- hibernate after idle
                                               |
                                               v
                                      delete after expiry
```

The first prompt claims a sandbox, clones the repository into
`/workspace/repository`, and runs the repository's `.agents/setup` hook. After
ten idle minutes the sandbox hibernates: compute stops and `/workspace`
survives. Docker restarts the container it stopped, so its whole filesystem is
still there and setup does not run again. Kubernetes rebuilds the pod around
the surviving volume, so the next prompt gets a new machine with the same
`/workspace`, and setup runs again there to put back what the repository
declares. After seven days idle it is deleted.
Archiving a session in the Web UI skips the clock: its sandbox and storage are
deleted at once, and the session can never run again.
Details: [`control-plane/README.md`](../control-plane/README.md#idle-and-hibernation).

### What happens if a sandbox cannot hibernate?

A Buildkite build cannot be paused, so that backend checkpoints instead: the
working tree is committed, the commits `origin` does not have are written to a
Git bundle in the control plane's state directory, the session's
`/workspace/artifacts` folder is tarred beside it, and the sandbox is
destroyed. The next prompt provisions a fresh sandbox, clones, runs
`.agents/setup`, and unpacks both. Kept: the branch, its commits, every tracked
or untracked file, and the artifacts folder. Lost: ignored files, installed
tools, and which changes were staged. Docker and Kubernetes hibernate properly.
Details:
[`control-plane/README.md`](../control-plane/README.md#idle-and-hibernation).

### How does the runner talk to the control plane?

It dials out. Every runner opens one WebSocket to the control plane's tunnel
listener and authenticates with a runner token the control plane generated; all
RPCs then flow control-plane → runner over that runner-initiated connection.
Nothing ever connects into a sandbox, and sandboxes accept no ingress at all.
Runners outside the cluster reach the same listener through a `/tunnel` path on
the Ingress that fronts the Web UI.
Details: [`runners/kubernetes.md`](runners/kubernetes.md#security-model),
[`control-plane/README.md`](../control-plane/README.md#tunnel).

### Can I still install plugins?

Yes, from the Web sidebar's **Plugins** page, or with
`dsh plugin --profile web add <package>` (on Kubernetes, `kubectl exec` into
the control-plane pod). The page installs, enables, disables, and removes
bundles, and lists the official bundles the installation ships switched off.
Installed bundles live in the profile on the data volume; an image upgrade
keeps them, refreshing only the control plane's own package. Caveats:

- a package without `dsh.bundle.patch` installs as a plain dependency and
  wires up nothing;
- if the upgrade cannot refresh the profile, the seed keeps the manifest it
  was working from as `package.json.before-reseed`, reseeds the profile from
  the image so the pod still starts, and says so in the pod log. The next boot
  merges that manifest back in and retries, so a transient failure repairs
  itself; if the refresh keeps failing, copy the kept file over `package.json`
  and run `pnpm install` in the profile;
- installed bundles run in the control-plane process, outside every sandbox,
  with the control plane's access to sessions and credentials. The Plugins
  page is operator access: admit to the Web UI only people you would give
  that to. The page can also switch this package's own bundle off; switch it
  back on there if that happens;
- Web sessions mount their tools through agent presets. Since dsh 0.1.7 a
  bundle patch _could_ restate a preset, but this package does not: the stock
  tool rows already run inside the sandbox, and staying off the preset rows
  keeps that true across dsh upgrades.
