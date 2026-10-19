# Runner on a Buildkite agent

This backend runs each sandbox as one build on a Buildkite pipeline you own.
The control plane triggers the build; the agent runs the runner container; the
runner connects back over the tunnel. Choose it when sessions should run
outside the cluster.

This is a supported backend, alongside Kubernetes agent-sandbox and Docker. The
pipeline shapes below have not been tested against every agent fleet; watch the
first build in your organization.

Install the [control plane](../control-plane.md) first.

## Prerequisites

- A Buildkite organization and permission to create a pipeline.
- An [API access token](https://buildkite.com/docs/apis/managing-api-tokens)
  with `read_builds`, `write_builds`, `read_pipelines`, `read_secrets_details`,
  and `write_secrets`, owned by someone who can manage the pipeline cluster's
  secrets (a cluster maintainer or an organization admin).
- A pipeline in a Buildkite cluster. Only clustered agents can read Buildkite
  secrets.
- Hosted Linux agents, or self-hosted agents that can run Docker.
- A tunnel address the agents can reach. Agents are not on the control-plane
  host, so an in-cluster address will not work.

## Create the pipeline

For hosted Linux agents, use this one command step. The control plane never
uploads steps: the pipeline's own definition is the only place they are defined.

```yaml
steps:
  - label: dsh sandbox
    image: "$DSH_YAWN_RUNNER_IMAGE"
    command: |
      # The agent's Docker socket is root-owned; the sandbox account needs it
      # for the repository's Docker workflows.
      chmod 666 /var/run/docker.sock 2>/dev/null || true
      exec runuser -u sandbox -- sh -c 'cd /workspace && exec dsh-yawn-runner'
    checkout:
      skip: true
    secrets:
      DSH_YAWN_REGISTRATION_TOKEN: DSH_YAWN_REGISTRATION_TOKEN
    timeout_in_minutes: 240
    agents:
      queue: hosted-amd64-small
```

Set `queue` to your hosted Linux queue. The agent and its startup hooks run as
root; the command launches the runner as `sandbox` (UID 1000) with
`HOME=/workspace/home`. Do not add `--login` or `--preserve-environment` to
`runuser`: the command needs to keep the `DSH_YAWN_*` job variables while
resetting `HOME`.

For self-hosted agents, use Docker instead:

```yaml
steps:
  - label: dsh sandbox
    command: >-
      docker run --rm --user 1000:1000
      -e DSH_YAWN_SANDBOX_ID -e DSH_YAWN_CONTROL_PLANE_URL -e DSH_YAWN_REGISTRATION_TOKEN
      "$DSH_YAWN_RUNNER_IMAGE"
    checkout:
      skip: true
    secrets:
      DSH_YAWN_REGISTRATION_TOKEN: DSH_YAWN_REGISTRATION_TOKEN
    timeout_in_minutes: 240
    agents:
      queue: self-hosted
```

Things the pipeline must get right:

- `DSH_YAWN_RUNNER_IMAGE`, `DSH_YAWN_SANDBOX_ID`, and
  `DSH_YAWN_CONTROL_PLANE_URL` come from the build environment the control
  plane sets. Never pin a runner image in the pipeline.
- `secrets` maps a
  [Buildkite secret](https://buildkite.com/docs/pipelines/security/secrets/buildkite-secrets)
  into the job: the key on the left is the variable the runner reads, and the
  value on the right is the secret's key, which may contain only letters,
  numbers, and underscores. You do not create the secret: the control plane
  creates `DSH_YAWN_REGISTRATION_TOKEN` in the pipeline's cluster, with an
  access policy for this pipeline, and keeps its value. This needs agent
  3.106.0 or later.
- Turn off **Skip intermediate builds** and **Cancel intermediate builds** in
  the pipeline's **Settings → Builds**. Every sandbox build uses branch
  `main`, so either setting would skip or cancel another live sandbox.
- Keep `agents.queue` explicit. It selects the fleet, and a second fleet means
  a second pipeline and profile.
- `timeout_in_minutes` bounds a sandbox's life if the control plane never
  cancels it. Buildkite may apply a lower ceiling of its own.
- Turn off the repository webhook, or leave the pipeline without a repository
  integration. Builds started by Buildkite alone have no sandbox variables and
  fail immediately.

## Point the control plane at the pipeline

On **Settings → Sandboxes → New profile**, pick backend `buildkite` and fill in
the organization, the pipeline, the control plane URL runners dial (such as
`wss://dsh.example.com/tunnel`), and the API token. The page stores the token
write-only on the control plane. No restart is needed.

To define the profile in Helm values instead, pass the token through the
environment from a Secret you own. The page cannot edit a profile defined in
values, so it cannot take that profile's token:

```sh
kubectl -n dsh-yawn create secret generic dsh-buildkite \
  --from-literal=token="$BUILDKITE_API_TOKEN"
```

```yaml
# dsh-yawn.values.yaml
controlPlane:
  sandboxManager:
    profiles:
      hosted:
        backend: buildkite
        organization: acme
        pipeline: dsh-yawn
        controlPlaneUrl: wss://dsh.example.com/tunnel
  extraEnv:
    - name: BUILDKITE_API_TOKEN
      valueFrom:
        secretKeyRef:
          name: dsh-buildkite
          key: token
```

Add these values to the file you installed with; keep its `auth.*` or `oidc.*`
sign-in values, or the chart refuses to render.

Then run `helm upgrade` with the values file. The pod reads its environment at
startup, so restart it after changing the Secret.

The control plane resolves the API token for each Buildkite request and never
sends it to a build or a runner. Every build uses branch `main`; if the pipeline
limits its build branches, include `main`. Then run a session: the control
plane creates a build, an agent picks it up, and the runner registers.

## Reaching the tunnel

An HTTP Ingress that passes WebSocket upgrades can carry the tunnel as one
`/tunnel` path rule on the Ingress that fronts the Web UI, under the same
certificate; the
[Ingress example](../control-plane.md#expose-the-web-ui) includes
that rule. Other shapes are in
[Tunnel](../../control-plane/README.md#tunnel).

## Several fleets

`agents.queue` is per pipeline, so a second fleet means a second pipeline and a
second profile. When both pipelines are in the same cluster, give the second
profile its own `secretKey` and map that key in its pipeline's `secrets`: the
secret the first profile creates is only readable by the first pipeline. The
composer shows a profile picker when more than one profile exists:

```yaml
- id: sandbox-manager
  config:
    defaultProfile: hosted
    profiles:
      hosted:
        backend: buildkite
        organization: acme
        pipeline: dsh-yawn
        controlPlaneUrl: wss://dsh.example.com/tunnel
      self-hosted:
        backend: buildkite
        organization: acme
        pipeline: dsh-yawn-self-hosted
        controlPlaneUrl: wss://dsh.example.com/tunnel
        secretKey: DSH_YAWN_SELF_HOSTED_TOKEN
```

## When a session goes idle

A Buildkite job cannot pause, so this backend checkpoints instead of
hibernating. The control plane commits the working tree, saves the commits
`origin` does not have and the `/workspace/artifacts` folder in its own state
directory, and cancels the build. The next prompt starts a new build, which
clones the repository, runs `.agents/setup`, and gets both back, with the
checkpoint commit undone so changes are uncommitted again.

Kept: the branch, its commits, every tracked or untracked file, and the
artifacts folder up to 64 MiB. Lost: ignored files, installed tools and
packages, other local branches, stashes, and which changes were staged. Put
what the session needs into `.agents/setup` so the next build recreates it.
A session in the Scratch Workspace has no repository, so only its artifacts
folder is kept; the rest of its working directory is lost.
The full rules are in
[Idle and hibernation](../../control-plane/README.md#idle-and-hibernation).

## Trust boundary

A Buildkite profile widens who can reach the control plane's secrets and build
agents:

- The API token can create and cancel builds on the pipeline and write the
  cluster's secrets. Anyone who can read the control plane's environment or
  credential store can trigger jobs on your agents.
- Every agent that can take the job, and everyone who can edit the pipeline's
  steps, can read `DSH_YAWN_REGISTRATION_TOKEN` and the secrets pushed to the
  runner after it registers. Give the pipeline its own cluster and queue rather
  than sharing them with unrelated CI.
- The job runs with whatever the agent grants it: a Buildkite-managed VM on
  hosted agents, your infrastructure on self-hosted agents.

## Limits

- No hibernation; see [When a session goes idle](#when-a-session-goes-idle).
  The first prompt after a restore says what did not come back.
- A build that does not start within `readyTimeoutMs` (default 10 minutes) is
  cancelled. Builds are polled every two seconds while waiting for an agent;
  raise the timeout on a busy self-hosted queue.
- Each resume calls the Builds API, so Buildkite's REST rate limit applies to
  the API token.
- Build states come from the Builds API, not the job. A build whose single job
  failed shows `failed`; a build blocked by an unrelated step is treated as
  never started and cancelled when the timeout passes.
- A build that Buildkite finishes or cancels outside dsh is reported as
  missing, and the next prompt gets a replacement.

## Next

[`credentials.md`](../credentials.md) gives sessions their credentials, starting
with `GITHUB_TOKEN`.
