# dsh-yawn Helm chart

Installs the dsh-yawn **control plane**: the dsh process, its data volume, the
runner tunnel, and the Kubernetes permissions the control plane uses to manage
sandboxes.

This chart does not install sandboxes. For the full installation order, see
[`docs/installations.md`](../../../docs/installations.md). The control-plane
phase is
[`docs/control-plane.md`](../../../docs/control-plane.md);
then install the
[Kubernetes sandbox pool](../../../docs/runners/kubernetes.md) or
[Buildkite runners](../../../docs/runners/buildkite.md).

Installing the chart alone gives you a working control plane: the Web UI,
sessions, secrets, instructions, and repository workspaces all work. The first
tool call in a session fails with a message naming the missing runner until a
runner is installed.

## Prerequisites

- A Kubernetes cluster and an OIDC identity provider, unless you reach the
  control plane over `kubectl port-forward`.
- A default StorageClass for the control plane data volume, or
  `controlPlane.persistence.storageClass`.

## Install

```sh
helm install dsh-yawn-control-plane oci://ghcr.io/zhming0/charts/dsh-yawn \
  --namespace dsh-yawn --create-namespace \
  --set oidc.enabled=true \
  --set oidc.hostname=dsh.example.com \
  --set service.type=LoadBalancer
```

The release must be named `dsh-yawn-control-plane` and live in one namespace
per control plane. Kubernetes runner manifests read the fixed names
`dsh-yawn-control-plane-tunnel`, `dsh-yawn-runner-config`, and
`dsh-yawn-registration-token`. This release owns the first two; the control
plane creates and owns the Secret.

Create the OIDC Secret first — the release notes print the command. It holds
`OIDC_ISSUER`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET`; register
`https://<oidc.hostname>/dsh-yawn/auth/callback` as the provider's redirect URI.
Until the Secret exists the pod cannot start. The control plane
signs users in itself, so there is no oauth2-proxy sidecar and no
`/launch-token` step. Without `oidc.enabled`, reach the control plane over
`kubectl port-forward` and open `/launch-token`.

## Values

| Key                                                      | Default                                  | Description                                                                                                                                    |
| -------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `controlPlane.image.repository`                          | `ghcr.io/zhming0/dsh-yawn-control-plane` | Control-plane image                                                                                                                            |
| `controlPlane.image.tag`                                 | `.Chart.appVersion`                      | Released tag                                                                                                                                   |
| `controlPlane.resources`                                 | `250m/512Mi → 2Gi`                       | Container resource requests and limits                                                                                                         |
| `controlPlane.extraArgs`                                 | `[]`                                     | Extra `dsh web` arguments                                                                                                                      |
| `controlPlane.extraEnv`                                  | `[]`                                     | Extra environment variables for credentials the control plane needs itself, such as `BUILDKITE_API_TOKEN` from a Secret; never sandbox secrets |
| `controlPlane.podAnnotations` / `controlPlane.podLabels` | `{}`                                     | Extra pod metadata                                                                                                                             |
| `controlPlane.persistence.enabled`                       | `true`                                   | `false` replaces the data PVC with an emptyDir; every restart then loses sessions, the credential store, and the registration token            |
| `controlPlane.persistence.size`                          | `5Gi`                                    | Data volume size                                                                                                                               |
| `controlPlane.persistence.storageClass`                  | `""`                                     | Data volume StorageClass; required when the cluster has no default                                                                             |
| `runner.controlPlaneUrl`                                 | Tunnel Service URL                       | Tunnel address written into `dsh-yawn-runner-config`; only change it for an unusual layout                                                     |
| `oidc.enabled`                                           | `false`                                  | Enable built-in OIDC sign-in and expose the control plane Service                                                                              |
| `oidc.hostname`                                          | `""`                                     | Required when enabled: bare host, no scheme                                                                                                    |
| `oidc.existingSecret`                                    | `dsh-yawn-oidc`                          | Secret holding `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET`                                                                       |
| `oidc.emailDomains`                                      | `*`                                      | Exact email domains admitted; restrict before trusting an issuer's whole user base                                                             |
| `oidc.scopes`                                            | `openid email profile`                   | OIDC scopes requested at the authorization endpoint                                                                                            |
| `oidc.clientAuthMethod`                                  | `client_secret_post`                     | Token-endpoint client authentication: `client_secret_post`, `client_secret_basic`, or `none`                                                   |
| `oidc.cookieMaxAgeDays`                                  | `30`                                     | Lifetime of the signed browser session                                                                                                         |
| `service.type`                                           | `ClusterIP`                              | Service exposure type                                                                                                                          |
| `service.port`                                           | `80`                                     | Service port in front of the control plane's 3000                                                                                              |
| `service.annotations`                                    | `{}`                                     | Annotations for the Service                                                                                                                    |
| `controlPlane.sandboxManager`                            | `{}`                                     | Default sandbox-manager settings; unset means no profile is seeded, so no sandbox can be provisioned                                           |

## Sandbox-manager settings as values

`controlPlane.sandboxManager` is the deployment base for the control plane's
sandbox-manager settings. The chart renders the runtime fields — `profiles`,
`defaultProfile`, `idleMs`, `expiresAfterMs`, and `readyTimeoutMs` — into
`/etc/dsh-yawn/sandbox-settings.yaml`. The Web UI's **Settings → Sandboxes**
page layers its own profiles and changes over that file. A profile defined in
the chart is locked in the page; a values change rolls the pod.

- Profiles from `controlPlane.sandboxManager` are the deployment defaults.
- A `kas` profile that omits `namespace` uses the release namespace.
- The section layout is an interface between the chart and the image. The image
  tag can lag the chart's, so a section the image does not know is ignored.
- The chart requires at least one profile, rejects startup-only fields in these
  values, and requires every `kas` profile to target the release namespace.

For a Kubernetes pool, name it in the profile:

```sh
helm upgrade dsh-yawn-control-plane oci://ghcr.io/zhming0/charts/dsh-yawn \
  --namespace dsh-yawn \
  --reuse-values \
  --set controlPlane.sandboxManager.profiles.standard.backend=kas \
  --set controlPlane.sandboxManager.profiles.standard.warmPool=dsh-yawn-universal
```

See [control-plane settings](../../../control-plane/README.md#settings) for the
full reference. Startup settings are not part of these values; set them in the
profile's `cordis.patch.yml`.

## Notes

- The data PVC has `helm.sh/resource-policy: keep`, so `helm uninstall` leaves
  sessions, credentials, and the seeded profile on the volume.
- The control plane generates the registration token, keeps it on the data
  volume, and writes it into the `dsh-yawn-registration-token` Secret. No chart
  value sets it, so `helm upgrade` and GitOps syncs never change it. To replace
  it, see
  [Registration token](../../../control-plane/README.md#registration-token).
- The chart deliberately ships no Ingress. Whatever fronts the control plane
  must serve HTTPS, pass WebSockets, and allow large RPC bodies; see
  [`docs/control-plane.md`](../../../docs/control-plane.md#expose-the-web-ui)
  for an nginx-ingress example.
