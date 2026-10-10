# Repository guidance

## Learn what dsh is before you change anything

dsh is DeepSeek Harness, an agent harness that shipped in 2026 as a pre-1.0
developer preview. It is almost certainly not in your training data, and there
is little public documentation. Do not guess its API or its behavior. Every
claim you make about dsh should come from a file you read.

The authoritative documentation is each npm package's own README, and those
READMEs are unusually detailed and precise. Read them directly:

```sh
cd "$(mktemp -d)"
npm pack @deepseek-ai/dsh-base@0.2.1-rc.1
tar xzf *.tgz
# package/README.md is the spec. package/lib/*.js is the built source, which is
# readable and worth grepping when a README leaves a detail open. A bundle also
# carries package/cordis.patch.yml, the rows it contributes.
```

This repository pins `0.2.1-rc.1`. Match it, because the surface moves between
releases.

### The model

dsh is a [Cordis](https://www.npmjs.com/package/@deepseek-ai/cordis) plugin
tree, composed at boot. Plugins publish services under a name (`fs`, `shell`,
`subprocess`, `agents`) and consume them with `static inject`. This package
supplies its own implementations of three of those services, so dsh's built-in
tools use a sandbox without knowing one exists.

| Term              | What it means                                                                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Profile**       | One installed tree, at `$DSH_HOME/profiles/<name>/` (`$DSH_HOME` defaults to `~/.dsh`). Holds `package.json` with the ordered `dsh.profile.bundles` list, plus your `cordis.patch.yml`.                               |
| **Bundle**        | An npm package declaring `dsh.bundle.patch`. Its patch file becomes a layer. This package is one.                                                                                                                     |
| **Patch layer**   | A YAML list of `{id, name, config}` rows plus `insert:` and `disabled:`. Layers apply over an empty list: bundles in order, then the profile's `cordis.patch.yml`, then `$DSH_HOME/cordis.patch.yml`, then `--patch`. |
| **Agent preset**  | A per-session composition, picked in the Web UI. Since dsh 0.1.7 presets are ordinary patch rows (`dsh-web-app/presets/*.patch.yml`). Different from a profile.                                                                                        |
| **Isolate realm** | `cordis:group` with `isolate:` gives a subtree its own copy of named services. A preset must use one for any service it publishes.                                                                                    |

### Which package answers which question

| Question                                          | Read                                                    |
| ------------------------------------------------- | ------------------------------------------------------- |
| Profiles, `dsh plugin`, launcher flags            | `@deepseek-ai/dsh`                                      |
| Patch layer precedence, `$DSH_HOME`, boot         | `@deepseek-ai/dsh-app-boot`                             |
| Which row ids exist, and their defaults           | `@deepseek-ai/dsh-base` (read `cordis.patch.yml`)       |
| What each surface changes                         | `@deepseek-ai/dsh-web-app`, `@deepseek-ai/dsh-headless` |
| Per-session compositions (preset rows)             | `@deepseek-ai/dsh-web-app` (`presets/*.patch.yml`)      |
| Config forms over row Configs                      | `@deepseek-ai/dsh-settings`                             |
| The interfaces this repo implements               | `@deepseek-ai/dsh-fs`, `-shell`, `-subprocess`          |
| How a Web session is created, including its `cwd` | `@deepseek-ai/dsh-api-session-controller`               |

### Verified facts that contradict a reasonable guess

Each of these was checked against the packages above. They are the ones most
likely to mislead you.

- `dsh plugin --profile <n> add <pkg>` is `pnpm add` in the profile directory
  and nothing more. A package without `dsh.bundle.patch` installs as a plain
  dependency and wires up nothing.
- A patch entry **replaces** the matched row's whole `config`. It does not deep
  merge, so an override must restate every field it keeps.
- `dsh web` starts a server and prints a URL. It does not start a session;
  sessions are created from the browser.
- The printed URL carries a per-process `?token=`. `GET /` without it, or
  without the cookie it mints, returns 401; static assets stay public. The
  cookie is bound to the `Host` the browser used and is signed with a secret
  kept in `$DSH_HOME/.credentials.yaml`, so it survives host restarts.
- A session's working directory falls back through selected workspace, then
  request payload, then `process.cwd()`. It is always set, and dsh creates the
  directory if it is missing.
- `shell` is built on top of `subprocess`, so `subprocess` is the seam that
  decides where a command actually runs.
- Since 0.2.1 the `workingDirectory` service owns each session's current
  directory: tools take their cwd from it, the model sees it as a "Current
  working directory" line, and the `working_directory` tool changes it. It
  starts from the session header's `cwd`, the host anchor, so the
  `sandbox-working-directory` row wraps the live service to answer in sandbox
  paths.
- `tool-fs-search` (`glob`, `grep`) injects `subprocess`, not `fs`, and spawns a
  ripgrep binary resolved from the dsh host's `node_modules`, with the session
  cwd and the model's search root in host coordinates. On its own it cannot
  work against a remote filesystem; this repository's sandbox subprocess seam
  translates the workdir, session-frame argv paths, and host-only executables
  so the stock row runs inside the sandbox.
- On the Web surface, tool rows are mounted by agent presets, and a preset
  row's `name:` is the module that loads. Since dsh 0.1.7 presets are ordinary
  patch rows (`preset-standard` and friends, shipped as
  `dsh-web-app/presets/*.patch.yml` behind an `agent-preset-registry` row), a
  bundle patch *can* restate one — but this repository still does not: the
  shipped presets restate tool rows by their stock names, and working through
  the three capability seams keeps that true. Web-editor preset changes
  persist into the profile's own `cordis.patch.yml`, the same file the image
  seeds once, and a session pinned to a preset id that no longer exists fails
  to resume — keep preset ids stable.
- A plugin reaches the Web settings surfaces through the volatile fields of
  its row Config (dsh 0.1.7's Config forms) plus, for a hand-written page, the
  `settings.section` slot. Namespace registration no longer exists.
- A settings-form write lands in the profile patch, but a home patch
  (`$DSH_HOME/cordis.patch.yml`) or `--patch` overlay outranks it, and the
  config editor refuses a write they would override. So a chart cannot deliver
  the sandbox-manager row as a home patch: the Web page cannot save, and the
  legacy `settings.yaml` import silently skips that row (renaming the file to
  `settings.yaml.imported`). Deployment values instead arrive as an ordinary
  base file the control plane reads, `/etc/dsh-yawn/sandbox-settings.yaml`,
  whose top-level `sandboxManager` section is the chart-to-image contract:
  the image tag can lag the chart's, so unknown sections are ignored and the
  file stays specific to this package. The deployment owns the profile names
  it defines; see control-plane/README.md.
- A patch entry's `name:` is an assertion, not a rename. When it differs from
  the matched row's module, `dsh-app-boot` skips the entry with a warning and
  the stock row stays as it was.
- The Web app serves a package's browser half (`dsh.client` in its
  `package.json`) only while a row of that package is mounted. Disabling
  `workspace-files` alone leaves the sidebar's Files and Preview tabs without
  their file resource provider, so the tab rows go with it. To change what a
  stock host service does, keep its row and wrap the live instance.
- The chat's inline images ride `GET /api/file?path=<absolute path>`
  (`SessionMediaReferences` in `dsh-api-session-controller`), a plain
  `connection.fetch` route that reads through `ctx.fs` with no session id in
  its URL and no agent turn around the call. Registering the path twice
  throws, so it cannot be shadowed. The chat `<img>` sets
  `referrerPolicy="no-referrer"`, so a `Referer` carries nothing. This
  repository's browser half adds a `dsh-yawn-session` query parameter to each
  such image's `src`, taken from the enclosing `[data-conversation-session]`
  or `[data-sidebar-right-session]` view (the same lookup dsh uses), and
  `sandbox-media-route` reads it on the `connection/request` waterfall. The
  full-size image dialog is portalled to `document.body`, outside every view,
  so it takes the session of the thumbnail just clicked, matched by exact
  URL. A cookie would race across tabs, and a path
  alone never names a sandbox, so there is deliberately no path-based
  fallback.

## Write code people can maintain

- Prefer plain English, direct names, and small functions with one clear job.
- Make the smallest change that fully solves the problem. Avoid speculative
  configuration, wrappers, and abstractions.
- Keep comments for decisions and non-obvious constraints. Do not narrate code
  that is already easy to read.
- Follow the existing style in the package you are changing.

## Respect the system boundaries

- `control-plane/` owns session lifecycle, credentials, and the Docker and
  Kubernetes backends.
- `runner/` owns commands and file operations inside one sandbox.
- `proto/` is the source of truth for the ConnectRPC contract between them.
- The runner dials out to the control plane's tunnel listener and
  authenticates with a runner token the control plane generated; RPCs then flow
  control-plane→runner over that runner-initiated connection. Do not add a
  listener on the runner for the control plane to dial, and do not give the
  runner any other channel back to the control plane.
- Keep control-plane paths and sandbox paths separate. Model-facing file and
  shell work must resolve inside the session's sandbox workspace.
- Preserve lifecycle meaning: hibernation keeps workspace data, wake reuses it,
  and expiry removes it.

## Preserve the supported product

- The product is the control-plane and runner images, released together. The
  control plane runs on Kubernetes through the Helm chart or on a VM with
  Docker. Sandboxes run on Docker, Kubernetes agent-sandbox, or Buildkite; all
  three are supported. Checkout installs are a development path.
- Only `dsh web` is supported. Headless mode exits before the idle lifecycle can
  run.
- The `web` profile on the data volume is user data as well as image data: an
  image upgrade merges the image's manifest fields and refreshes its own
  package, and keeps plugins installed from the Web Plugins page. Installed
  bundles run in the control-plane process, outside every sandbox, so the page
  is operator access.
- One control plane is one trust domain. Its sessions, credentials, and
  sandboxes are not isolated from other users admitted to that control plane.
- Secrets live in the control plane's broker store and are pushed to a runner
  before commands, in two scopes: global secrets reach every sandbox, and a
  workspace secret reaches that workspace's sandboxes and overrides a global
  secret of the same name. Scoping limits delivery, not access: one control
  plane is still one trust domain.
  `GITHUB_TOKEN` also supplies Git credentials for github.com; a
  workspace-scoped one serves that workspace's clones. There is no GitHub
  device flow.
- Sandbox code can read injected secrets by design. Keep credentials in the
  control-plane store, never in pod configuration or workspace files. Two are
  deliberate exceptions, because a sandbox must never receive them: the runner
  token, which the control plane generates and keeps on its data volume and
  writes into the `dsh-yawn-registration-token` Secret because warm pods must
  hold it before any session exists (it only lets a runner register a tunnel,
  and grants nothing else), and a Buildkite API token, which the control plane
  resolves for its own Buildkite calls from the process environment or the host
  credential document (write-only from the Sandboxes page) because it can
  create and cancel builds.
- The Kubernetes backend uses cluster-owned templates and warm pools. The
  operator publishes them as named sandbox profiles; a session picks a profile,
  never pod privileges or an arbitrary template.

## Protect credentials and generated code

- Never write tokens or secret values into a workspace, log, test fixture, or
  committed file. The control plane stores credentials; the runner holds
  delivered values in memory.
- Do not hand-edit generated protobuf files. Change `proto/` and run
  `pnpm proto:generate`.
- The pinned dsh, agent-sandbox, Go, `jj`, and `mise` versions are intentional.
  Update them only as part of an explicit compatibility change.
- `mise.toml` is the only place CI and local development read tool versions
  from. Do not reintroduce a version in a pipeline image, a step script, or the
  README. pnpm is the exception: `packageManager` in `package.json` pins it.

## Inspect Buildkite CI

Use `bk`, pinned in `mise.toml`, to inspect this repository's CI in the
`zhming0` organization and `dsh-yawn` pipeline. Prefer the pre-provisioned
`BUILDKITE_API_TOKEN`; it takes precedence over the credential store and legacy
config, and `BUILDKITE_ORGANIZATION_SLUG` selects the organization, so no login
is needed when they are set. Do not run `bk auth login --device` or any
interactive login unless the user explicitly asks. If the token is absent,
report that and stop. When explicitly asked to log in from a headless sandbox,
run `bk auth login --device --credential-store shm`; then confirm with
`bk auth status`.

## Test the affected path

For TypeScript or protobuf changes, run:

```sh
pnpm check
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

For runner changes, also run:

```sh
(cd runner && go test -race ./... && golangci-lint run && go build ./...)
```

Run `pnpm test:docker` for Docker lifecycle, runner protocol, setup, credential,
or sandbox tool changes. Run `pnpm test:kas` for control-plane-to-runner transport, Kubernetes
lifecycle, or manifest changes. Regenerate protobuf code and confirm
there is no generated-code diff when the contract or generator settings change.

Follow [`docs/e2e-testing.md`](docs/e2e-testing.md) for the complete Docker,
Kubernetes, and browser/model acceptance workflows, including expected results,
cleanup, and failure investigation. For a change that needs a real session —
credentials, sandbox lifecycle, tool routing, settings, or a Web UI
contribution — start a disposable control plane with `node scripts/dev.mjs
start` and assert from the session's sandbox, as that page describes.

Update the relevant README or `docs/` page when behavior, configuration,
security boundaries, setup, or supported limits change.
