# Runner on Kubernetes agent-sandbox

This backend runs each session in a Kubernetes pod managed by
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox). A warm pool
is a set of pre-started pods, so a new session usually claims one instead of
waiting for a cold start. The control plane creates a `SandboxClaim` per
session, the runner in the pod connects back to the control plane's tunnel, and
nothing connects in.

This is a supported backend, alongside Buildkite and Docker. It is pinned to agent-sandbox **v1.0.2**
(`agents.x-k8s.io/v1beta1` and `extensions.agents.x-k8s.io/v1beta1`). Do not
assume these manifests work with another release.

Install the [control plane](../control-plane.md) first.

## Prerequisites

- **Agent-sandbox controllers v1.0.2**, installed below. A Helm chart cannot
  own another project's CRDs, so this is a manual step.
- **The pool must be in the control-plane release namespace.** Its template
  reads the `dsh-yawn-runner-config` ConfigMap and the
  `dsh-yawn-registration-token` Secret from that namespace, and the control
  plane's Role and tunnel Service live there. The chart also requires every
  Kubernetes profile to target that namespace.
- **Nodes that allow a privileged container.** Each sandbox runs a rootless
  Docker daemon sidecar so sessions can build images. To drop it, delete the
  `docker` container and its two `emptyDir` volumes from the template and the
  runner's `DOCKER_HOST` entry. The Docker CLI then reports that no daemon is
  reachable. [Docker inside a sandbox](#docker-inside-a-sandbox) explains why
  the sidecar is privileged.

## Install the controllers

```sh
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.2/sandbox-with-extensions.yaml
kubectl wait --for=condition=Established \
  crd/sandboxes.agents.x-k8s.io \
  crd/sandboxclaims.extensions.agents.x-k8s.io \
  crd/sandboxtemplates.extensions.agents.x-k8s.io \
  crd/sandboxwarmpools.extensions.agents.x-k8s.io --timeout=120s
kubectl -n agent-sandbox-system wait --for=condition=Available deployment --all --timeout=180s
```

If you are upgrading from v0.5.x, follow the
[agent-sandbox migration guide](https://github.com/kubernetes-sigs/agent-sandbox/blob/v1.0.2/docs/api-migration-guide.md)
first.

## Apply the sandbox pool

The checked-in base names no namespace, so applying it directly fails. Write an
overlay that sets the namespace and pins the runner image to the same release
as the control plane. Use one concrete version in both `<release-tag>`
placeholders.

```yaml
# dsh-yawn-runner/kustomization.yaml
namespace: dsh-yawn
resources:
  - https://github.com/zhming0/dsh-yawn//deploy/kubernetes/runner?ref=<release-tag>
images:
  - name: ghcr.io/zhming0/dsh-yawn-runner
    newTag: <release-tag>
```

From a checkout, point `resources` at `../deploy/kubernetes/runner` instead of
the remote base. Then apply it:

```sh
kubectl apply -k dsh-yawn-runner

kubectl -n dsh-yawn wait --for=jsonpath='{.status.readyReplicas}'=1 \
  sandboxwarmpool/dsh-yawn-universal --timeout=300s
```

The base contains a `SandboxTemplate` describing the sandbox pod, a
`SandboxWarmPool` keeping pods warm, and nothing else. It reads the control
plane's URL from the ConfigMap the chart wrote and the registration token from
the Secret the control plane wrote, so the namespace is the only
cluster-specific value.

## Configure the pool

Change a pool with a JSON patch in your overlay. Address lists as a whole
rather than by index: Kubernetes treats a custom resource list as one value,
and a new release may reorder entries.

```yaml
patches:
  - target: { kind: SandboxWarmPool, name: dsh-yawn-universal }
    patch: |-
      - op: replace
        path: /spec/replicas
        value: 4
  - target: { kind: SandboxTemplate, name: dsh-yawn-universal }
    patch: |-
      - op: replace
        path: /spec/volumeClaimTemplates
        value:
          - metadata:
              name: workspace
            spec:
              accessModes: [ReadWriteOnce]
              storageClassName: rook-ceph-block
              resources:
                requests:
                  storage: 10Gi
      - op: add
        path: /spec/podTemplate/spec/resources
        value:
          requests: {cpu: 200m, memory: 512Mi}
          limits: {cpu: "4", memory: 6Gi}
```

The checked-in network policy allows the tunnel to the control plane (TCP
8081), DNS (TCP/UDP 53), and HTTP/HTTPS (80 and 443). Narrow the 80/443 rule in
production. The runner's Docker data `emptyDir` is patched the same way, as a
whole list under `/spec/podTemplate/spec/volumes`. See
[Security model](#security-model).

## Point the control plane at the pool

```yaml
# dsh-yawn.values.yaml
controlPlane:
  sandboxManager:
    profiles:
      standard:
        backend: kas
        warmPool: dsh-yawn-universal
```

```sh
helm upgrade dsh-yawn-control-plane oci://ghcr.io/zhming0/charts/dsh-yawn \
  --namespace dsh-yawn \
  --values dsh-yawn.values.yaml
```

The chart mounts these values at `/etc/dsh-yawn/sandbox-settings.yaml`, and the
Web UI's **Settings → Sandboxes** page layers its own profiles and changes over
them. A values change rolls the control plane pod. Profiles defined in values
are locked in the page. A `kas` profile that omits `namespace` uses the release
namespace, which is where the pool and the control plane's Role live.

Now run a session and send a prompt: a warm pod is claimed, the repository is
cloned into it, and tools run there.

## Several pools

A second pool needs a second template and warm-pool pair, plus a second
profile. Copy the two YAML files in
[`deploy/kubernetes/runner`](../../deploy/kubernetes/runner) under a new name,
change the container resources and the volume request, add them to your
kustomization, and list both profiles:

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

The same approach works for a structurally different pool: gVisor, custom
tolerations, or a different security context. A session can only pick from the
pools the cluster operator publishes.

## Security model

Each sandbox pod has two containers:

- **runner** — runs as UID 1000, serves the file, shell, and subprocess RPCs,
  and holds the session's tools. It has `allowPrivilegeEscalation: true` and a
  small set of capabilities so apt, dpkg, and sudo can install system packages.
  Seccomp stays `RuntimeDefault`. The pod lowers
  `net.ipv4.ip_unprivileged_port_start` to 0, as Docker does, so a session
  binds ports 80 and 443 without a capability.
- **docker** — a rootless Docker daemon sidecar. The runner's Docker CLI talks
  to it over a shared socket, so sessions can run `docker build` and
  `docker run` without access to the node's Docker daemon.

The pod uses the `runc` runtime by default, which is container isolation, not a
virtual-machine boundary for hostile code. For a stronger boundary, install and
verify a gVisor `RuntimeClass` on every eligible node and add
`runtimeClassName: gvisor` under `podTemplate.spec`. The Docker sidecar has
only been tested under `runc`.

The pod mounts no service-account token and has no Service. Its NetworkPolicy
denies all ingress, and allows egress only to the control-plane tunnel (TCP
8081), DNS (TCP/UDP 53), and HTTP/HTTPS (80 and 443). The broad 80/443 rule
reaches cluster and private addresses too, so production clusters should
narrow it to approved CIDRs or use an FQDN-aware network policy.

The runner dials the `dsh-yawn-control-plane-tunnel` Service
(`ws://dsh-yawn-control-plane-tunnel.dsh-yawn.svc.cluster.local:8081/tunnel`)
and presents the registration token and its Sandbox name, which the control
plane checks against the claim. Inside the cluster the tunnel is plaintext, so
the control plane's authenticity rests on the cluster network being trusted.

The control plane's Role is namespace-scoped. It manages `sandboxclaims`,
reads and patches `sandboxes`, and grants nothing cluster-wide.

### Docker inside a sandbox

The `docker` sidecar runs the upstream `docker:29.8.0-dind-rootless` image. It
is a rootless daemon: the process runs as UID 1000 and creates its own user
namespace, so "root" inside containers it starts is UID 1000 on the node.

The sidecar and the runner mount the workspace volume at the same `/workspace`
path, so bind mounts see the session checkout. Files the runner owns appear
root-owned inside a container, and files a container writes as root come back
as UID 1000. A published port is reachable at the pod's `localhost`.

The sidecar is privileged because rootlesskit needs user and mount namespaces
and nested runc needs a fresh `/proc`. The default seccomp profile, AppArmor,
and masked `/proc` paths refuse those; `privileged: true` is the only
Kubernetes switch that lifts all three. The process stays UID 1000 with an
empty effective capability set, and privileged mode does not give it root on
the node — but it does remove seccomp and AppArmor protection for that
container. The pod no longer satisfies the `baseline` Pod Security Standard; a
namespace that enforces it rejects the pod.

### System packages

The sandbox user has passwordless sudo, so a repository whose setup installs
system packages works without a custom image. The permission stays inside the
runner container, but code in the sandbox can write anywhere in that
container, including over the runner's files. If that is the wrong trade for a
shared cluster, remove the sudoers file in a custom image.

## What survives a wake

Hibernation suspends the Sandbox; waking recreates the pod around the
surviving workspace volume, and the runner runs `.agents/setup` again on the
new machine. Expiry deletes the claim and its volume.

- **Kept**: `/workspace` — the repository checkout, `/workspace/home`, the
  artifacts folder, and an apt cache at `/workspace/.dsh-yawn/apt-cache`, so
  `.deb` files are not downloaded twice. The checked-in template requests 6Gi,
  with room for up to 2GiB of `.deb` files. Size it for the toolchains a
  session installs.
- **Lost**: `/tmp`, running processes, packages apt installed under `/usr` and
  `/var`, and the Docker sidecar's images, containers, and volumes. Those live
  on a 10Gi `emptyDir`, so the kubelet does not walk every image layer for
  `fsGroup` ownership at each pod start. Raise its `sizeLimit` in the template
  if sessions build large images.

## OpenTelemetry

The control plane records claim time, resume time, lifecycle changes, and
command time through dsh's OpenTelemetry setup.

To export from runners, add standard `OTEL_EXPORTER_OTLP_*`,
`OTEL_TRACES_EXPORTER`, or `OTEL_METRICS_EXPORTER` variables to the runner
container in the template. Their endpoint must also be allowed by the egress
policy. With no exporter variables set, the runner does not contact a
collector.

## Next

[`credentials.md`](../credentials.md) gives sessions their credentials, starting
with `GITHUB_TOKEN`.
