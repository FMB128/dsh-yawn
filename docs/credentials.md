# Credentials and secrets

Sandboxes have no credentials of their own; they receive the control plane's.
The control plane keeps one store of named secrets and pushes the current
values to the runner before each command, which injects them into that
command's environment.

There are two scopes:

- **Global** secrets reach every sandbox.
- **Workspace** secrets reach the sandboxes of one repository Workspace and
  override a global secret with the same name.

A sandbox receives the global set with its workspace's overrides applied and
nothing from other workspaces. Scoping limits which sandbox receives a value;
it does not isolate users from one another. Anyone admitted to the control
plane can reach every sandbox.

This is the step after [installation](installations.md): the control plane and
a runner come first.

## GITHUB_TOKEN

`GITHUB_TOKEN` is the secret most installs need. It is injected like any other
secret, and it doubles as the Git credential for github.com: the control plane
serves it to Git over a Unix socket, so it never lands in the workspace or in a
remote URL. Every sandbox gets it, whichever host its own repository is on, so
a session in a GitLab Workspace can still clone from GitHub.

Use a fine-grained personal access token scoped to the repositories sessions
work on, with **Contents: read** — add write access if the agent should push.
If you are logged in with the GitHub CLI, `gh auth token` prints a suitable
token. Without one, sessions can still clone public repositories; private
repositories fail at `git clone`. A workspace-scoped token serves that
workspace's clones instead of the global one, so two Workspaces can use two
tokens.

## Other Git hosts

`GITHUB_TOKEN` is the built-in github.com credential. Other hosts go on
**Settings → Git credentials**, one row per host:

| Host                   | Username       | Secret            |
| ---------------------- | -------------- | ----------------- |
| `git.fml128.ch`        | `oauth2`       | `FORGE_TOKEN`     |
| `bitbucket.org`        | `x-token-auth` | `BITBUCKET_TOKEN` |
| `git.example.com:8443` | `oauth2`       | `EXAMPLE_TOKEN`   |

The host is matched exactly as Git sends it, including a non-default port, and
a hyphenated hostname needs no special spelling. The username defaults to
`oauth2`, which GitLab and many token-based forges accept; use the forge's own
convention when it differs. The secret is resolved through the same two scopes
as every other secret, so a workspace-scoped secret overrides the global one
inside that workspace. A row whose secret is not set is skipped, and the page
marks it **not set**. A row for github.com replaces the built-in `GITHUB_TOKEN`
entry even before its secret is set; remove the row to fall back.

New Workspaces clone over HTTPS. An SSH clone URL is converted to HTTPS when
the Workspace is created, so a host's token is usable; an explicit SSH port,
HTTP,
and `git://` are rejected because the right HTTPS port is ambiguous or the
transport is unauthenticated—enter the HTTPS URL instead. SSH keys are not
managed yet, and an existing SSH Workspace keeps the URL it was created with;
recreate it from the HTTPS URL to use this table. The old Workspace and its
workspace-scoped secrets stay with the SSH URL, so add those secrets again for
the HTTPS Workspace.

## Set a secret

Secrets go in through the Web UI: **Settings → Secrets**. It is the only way
in, and values are write-only: the page lists names, never values, grouped
by scope. **Add secret** stores a name under **Global · All workspaces** or one
repository Workspace; **Replace** sets a new value for an existing one. A name
stored in both scopes resolves to the workspace's value inside that workspace
and to the global value everywhere else. The Scratch Workspace has no
repository and no scope of its own, so its sessions get the global secrets.

A change applies before the session's next command, including to running
sessions: before every command the control plane re-reads the store and pushes
the session's effective set to its runner. No control-plane restart is needed.

## Credentials the control plane owns

Two credentials belong to the control plane and must never reach a sandbox:

- **The registration token**. The control plane generates it, keeps it on its
  data volume, and writes it where runners read it: the
  `dsh-yawn-registration-token` Secret, because warm pods must hold it before
  any session exists, or a Buildkite cluster secret. It only lets a runner
  register a tunnel. Nobody needs to read or copy it.
- **A Buildkite API token**, which can create and cancel builds and write the
  pipeline cluster's secrets. Store it in a
  Secret you own and pass it to the control plane with
  `controlPlane.extraEnv`, or enter it on **Settings → Sandboxes** when you
  create a Buildkite profile. The page writes it, write-only, to
  `$DSH_HOME/.credentials.yaml` on the control plane's data volume, under a
  name derived from the profile:
  `DSH_YAWN_BUILDKITE_<PROFILE>_TOKEN`. A stored token is used before the
  environment fallback.

[`runners/buildkite.md`](runners/buildkite.md#point-the-control-plane-at-the-pipeline)
sets the Buildkite token up, and
[`control-plane/README.md`](../control-plane/README.md#registration-token)
covers replacing the registration token.

## Never write values down

A secret value must not appear in `cordis.patch.yml`, in a values file, in a
committed file, or in chat. Those are plain text, and transcripts are durable.

Sandbox code can read injected secrets — that is what they are for. Treat
everything in the store as visible to whatever a session runs. Keep each
secret as narrow as the work needs, and delete ones you stop using.
