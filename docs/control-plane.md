# Control plane

The control plane is the dsh process, its data volume, and the runner tunnel.
It runs on Kubernetes through the Helm chart, or on a VM with Docker. Sandboxes
run elsewhere; see the [installation index](installations.md).

- [Kubernetes](#kubernetes)
  - [Prerequisites](#prerequisites)
  - [Install](#install)
  - [Expose the Web UI](#expose-the-web-ui)
  - [Verify](#verify)
  - [Upgrade](#upgrade)
- [VM or other Docker host](#vm-or-other-docker-host)
  - [Run the container](#run-the-container)
  - [Authentication](#authentication)
  - [Upgrade](#upgrade-1)

## Kubernetes

The `dsh-yawn` Helm chart installs the control plane and the Kubernetes
permissions it needs to manage sandboxes.

### Prerequisites

- A Kubernetes cluster you administer, with `kubectl` 1.27 or later.
- `helm` 3.8 or later.
- A default StorageClass, or a storage class name for the control plane's data
  volume.
- An OIDC identity provider with a confidential client, unless
  `kubectl port-forward` access is enough. The control plane runs the sign-in
  flow itself, so no auth proxy is required.

### Install

The examples use namespace `dsh-yawn`. One namespace holds one control plane,
and the release must be named `dsh-yawn-control-plane`: the Kubernetes runner
manifests read fixed names that this release owns.

Create the OIDC Secret first. Secret values do not belong in values files, so
the chart deliberately never sees them:

```sh
kubectl create namespace dsh-yawn
kubectl -n dsh-yawn create secret generic dsh-yawn-oidc \
  --from-literal=OIDC_ISSUER=https://your-idp/realm \
  --from-literal=OIDC_CLIENT_ID=dsh-yawn-control-plane \
  --from-literal=OIDC_CLIENT_SECRET=…
```

Register `https://dsh.example.com/dsh-yawn/auth/callback` as the client's
redirect URI. The control plane creates its browser-session signing secret on
the data volume on first boot, so the chart stores no cookie secret.

```yaml
# dsh-yawn.values.yaml
oidc:
  enabled: true
  hostname: dsh.example.com
  emailDomains: your-company.com
service:
  type: LoadBalancer
```

```sh
helm install dsh-yawn-control-plane oci://ghcr.io/zhming0/charts/dsh-yawn \
  --namespace dsh-yawn \
  --values dsh-yawn.values.yaml
```

The chart also creates the ServiceAccount, Role, and RoleBinding the Kubernetes
backend uses: `sandboxclaims`, `sandboxes`, and the
`dsh-yawn-registration-token` Secret the control plane keeps current.
Kubernetes cannot limit `create` to one Secret name, so the Role can create any
Secret in the namespace; `patch` is limited to that one Secret.

### Expose the Web UI

The chart's Service is a ClusterIP anchor by default. Either set
`service.type=LoadBalancer`, as above, or point your own Ingress or Gateway API
route at it. Whatever fronts dsh must serve HTTPS, because the session cookie
is secure, and pass WebSockets and large request bodies. With ingress-nginx:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: dsh-yawn-control-plane
  namespace: dsh-yawn
  annotations:
    # The Web UI holds WebSockets open at /api/events.* and can carry large
    # attachments; nginx's defaults are too small.
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-body-size: 300m
spec:
  ingressClassName: nginx
  rules:
    - host: dsh.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: dsh-yawn-control-plane
                port:
                  name: http
          # Only for runners outside the cluster, such as Buildkite agents.
          # It skips sign-in: the registration token protects the tunnel.
          - path: /tunnel
            pathType: Exact
            backend:
              service:
                name: dsh-yawn-control-plane-tunnel
                port:
                  name: tunnel
  tls:
    - hosts: [dsh.example.com]
      secretName: dsh-yawn-tls
```

The host must match `oidc.hostname`. The chart passes it to dsh as
`--trusted-host`, because dsh rejects `/api` requests whose `Host` header is
neither loopback nor trusted.

Users open `https://dsh.example.com/` and sign in through the identity provider;
the control plane mints its own browser session, so there is no separate
`/launch-token` step. Everyone the provider admits shares the same sessions,
secrets, and sandboxes, so set `oidc.emailDomains` accordingly.

Without `oidc.enabled`, use a port-forward:

```sh
kubectl -n dsh-yawn port-forward deploy/dsh-yawn-control-plane 3000:3000
# open http://localhost:3000/launch-token
```

### Verify

```sh
kubectl -n dsh-yawn rollout status deployment/dsh-yawn-control-plane --timeout=300s
```

The pod becomes Ready when dsh is serving. Open the address you exposed; you
should land signed in. You can then create a session, add secrets, and add a
repository workspace. The first tool call fails until a runner is installed,
which is expected.

### Upgrade

`helm upgrade` moves the control plane. It does not change runners; re-apply
their manifests at the matching version to move their image.

The data volume carries the dsh profile across the upgrade. On the first boot
of a new image, the image's seed refreshes the control plane's own package and
keeps everything else in the profile, including plugins installed from the Web
UI. If that refresh fails, the seed logs a warning, keeps the previous
`package.json` as `package.json.before-reseed`, and retries on the next boot.

## VM or other Docker host

The same control-plane image runs as one Docker container on any machine you
keep on. Sandboxes then run as sibling containers on that machine's Docker, or
on Buildkite. The image can run OIDC sign-in itself, so this path needs only the
HTTPS proxy; without OIDC, use a port-forward or an authenticating proxy in
front.

### Run the container

Put the provider registration in an owner-only env file outside the repository:

```sh
# /etc/dsh-yawn/oidc.env
DSH_YAWN_OIDC_ISSUER=https://your-idp/realm
DSH_YAWN_OIDC_CLIENT_ID=dsh-yawn-control-plane
DSH_YAWN_OIDC_CLIENT_SECRET=…
DSH_YAWN_OIDC_REDIRECT_URL=https://dsh.example.com/dsh-yawn/auth/callback
```

Register `https://dsh.example.com/dsh-yawn/auth/callback` as the client's
redirect URI, then run:

```sh
docker run -d --name dsh-yawn --restart unless-stopped \
  --network host \
  --env-file /etc/dsh-yawn/oidc.env \
  -v dsh-yawn-data:/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/zhming0/dsh-yawn-control-plane:<version> \
  --trusted-host dsh.example.com
```

This differs from the [README's quick start](../README.md#quick-start) on
purpose:

- `--network host` without `DSH_YAWN_BIND_ALL` keeps the Web UI on the VM's
  loopback, `127.0.0.1:3000`, as in the Kubernetes pod. Sandbox containers
  cannot reach it, so only your proxy can reach the sign-in routes. On a Docker
  network the quick start's way, a sandbox could reach port 3000 and take the
  sign-in token.
- The runner tunnel listens on port 8081 on every interface, so sandboxes on
  this machine can dial it. Keep it off the internet with a firewall.
- `--trusted-host` names the hostname users open. dsh rejects `/api` requests
  whose `Host` header is neither loopback nor trusted.
- The `dsh-yawn-data` volume holds the profile, sessions, credentials, and the
  browser-session signing secret.

### Authentication

With the `DSH_YAWN_OIDC_*` names set, the control plane runs the authorization
code flow itself and admits the browser from its signed session cookie. Users
open `https://dsh.example.com/` and sign in through the provider; there is no
`/launch-token` step. The proxy must:

- serve HTTPS and proxy to `http://127.0.0.1:3000`, passing the `Host` header
  through;
- pass WebSockets, keep connections open for hours, and accept request bodies
  of a few hundred megabytes.

Without OIDC, set `-e DSH_YAWN_CONTROL_PLANE_LAUNCH_TOKEN_ROUTE=1`, keep the
port on loopback, and use a port-forward with
`http://localhost:3000/launch-token`; an authenticating proxy in front can use
the same route. Everyone admitted shares the same sessions, secrets, and
sandboxes.

For runners outside this machine, such as Buildkite agents, also route the
exact path `/tunnel` to port 8081 and leave authentication off that path: the
registration token already protects it. Runners then dial
`wss://dsh.example.com/tunnel`. See
[Tunnel](../control-plane/README.md#tunnel).

### Upgrade

Pull the new version, remove the container, and run the same command with the
new tag. The data volume keeps the profile and installed plugins, as on
Kubernetes.
