# How the dsh-yawn control plane works

This page is for maintainers and covers the dsh plugin internals this package
relies on. Most operators and users do not need it; see
[`README.md`](README.md) for the package reference.

It assumes familiarity with dsh plugins, patch layers, and row configs. Every
detail was checked against the pinned dsh release, and some of it depends on
implementation details that a dsh upgrade can change.

## What installing it changes

The package declares a bundle patch. Once the package is installed in a
profile, dsh includes that patch in the layer stack on boot. It replaces three
host capability rows (`fs-sandbox`, `bash-sandbox`, `subprocess`) with
sandbox-backed ones. The tool rows are left alone: the stock tools keep their
names, schemas, prompt guidance, and caps, and reach the sandbox through those
three services without knowing one exists.

The stock `tool-fs-search` row (`glob`, `grep`) is the case that needs the
subprocess seam to translate paths, not just relay them. It spawns the host's
packaged `@vscode/ripgrep` binary with the session working directory and the
model's search root, all in host coordinates that do not exist in a sandbox.
The seam maps every path it can prove is the session workspace onto the sandbox
workspace — the workdir and any absolute argv element under the session
workspace — and resolves an executable path the sandbox cannot have to the
sandbox's own build of the same tool name (`rg` on the runner image). Anything
else in argv passes through unchanged. This is the same translation the shell
and filesystem seams apply to their paths, so a stock row that assumes the host
world runs against the sandbox whether the Web surface mounts it from a shipped
agent preset, a copied one, or the [`examples/`](../examples/agent.cordis.yml)
preset.

Subagent sessions share the root session's sandbox. Every sandbox lookup keys
on the agent's top-level session — resolved from the durable `parentSession`
lineage of a child session header that carries `origin: subagent` — so
delegation reads and writes one working copy, a child's first tool call boots
the root's sandbox, and a child turn holds it against idle and release exactly
as a root turn does (turns are counted per key, so a parent and a child turning
at once keep the sandbox alive until both close). There is no locking or
conflict detection between a parent and its subagents; the sandbox boundary is
the containment. Resolution is memoized per session, so a child never switches
sandboxes when an ancestor is disposed mid-run; a child whose parent cannot be
resolved at all (absent or disposed ancestor) falls back to its own sandbox,
and the fallback is logged as a warning.

A Fork is not a subagent. dsh records a fork's source in the same
`parentSession` field, but a fork is a top-level session that owns a fresh
working copy, so it never shares the source's sandbox: starting a fork wakes
nothing and hibernating or releasing it leaves the source's sandbox alone. The
two are told apart by `origin`, which only a real subagent child sets. That
field is doing load-bearing work here even though dsh describes it as
presentation metadata, so a dsh change to how subagent children are marked
would silently cost delegation its shared working copy; see the risk note in
[`src/manager/root-session.ts`](src/manager/root-session.ts).

Uploaded attachments are copied into the sandbox on demand. dsh stores an
upload on the host and asks the filesystem row to map its host path into the
tool execution world; a sandbox shares no path with that host, so before each
model request the filesystem copies every attachment the request references
into `<workspace>/.dsh-attachments` and answers that mapping. Copies are keyed
by root session, so a subagent reads its root's copy, and they survive
hibernation because the workspace volume does. The mapping itself lives in
host memory, so the first request after a host restart copies again.

In the Web profile, the package replaces directory picking with a repository
URL dialog. It creates an owner-only host anchor, registers it as a dsh
Workspace named `owner/repo`, and returns that path through dsh's normal picker
contract. dsh therefore sets the immutable session `cwd` before creation and
groups its history normally, while repository files remain inside the sandbox.

The Web profile also replaces dsh's stock `@` file discovery
(`file-reference-local`). The stock row walks the session `cwd` on the host
filesystem, which here is the anchor directory above — it holds only
`repository.json`, so `@` would never see repository files. A
`sandbox-file-reference` row answers the same `fileReferences` service by
asking the runner to walk the sandbox workspace (one recursive `Tree` RPC per
refresh), and returns the same workspace-relative candidates with the same
exclusions and ranking as the stock provider. The listing is cached per
session and refreshed after the next tool result.

Typing `@` neither wakes a hibernated sandbox nor creates a session's first
one. The completion menu asks for file candidates on every keystroke whether
or not the user wants a file, so file discovery never starts a machine: a
session with no sandbox record answers an empty file list, and the next `@`
after the first prompt sees the files. As a sandbox hibernates, the manager
walks its workspace once and saves the listing under
`<stateDir>/file-index/<session>.json`; a hibernated workspace cannot change,
because every write goes through a tool call that first wakes the sandbox, so
that saved listing is exact until the next wake. `@` on a hibernated session
reads it, and the file is removed with the session record. If no index exists
for a session that has a sandbox (the host restarted while the sandbox was
running, or the walk failed), `@` falls back to waking the sandbox.

The Web profile also gains a **Settings → Secrets** page. It edits the
control plane's broker store: the browser sends names and values in and receives
only names back, never a value. **Settings → Sandboxes** edits the live slice
of the sandbox-manager settings described under
[Settings](README.md#settings): sandbox profiles, the default profile, and the idle
and expiry timers, applied on the host without a restart.

The **Settings → Instructions** page manages AGENTS.md-style guidance at two
scopes: one global layer and one layer for each repository Workspace. These
layers live in host state rather than in repository checkouts.

The **Settings → Notifications** page turns on a browser notification when a
turn finishes while the page is in another tab or window; clicking the
notification opens that session. The browser already receives one running/idle
bit per session on the session list feed, so this needs no host round-trip and
no new endpoint, and the on/off choice is stored in the browser rather than on
the control plane. It needs the page to stay open: a fully closed browser
receives nothing. It also needs the Notifications API, which is not universal:
an insecure page and a browser that does not offer the API at all get separate
messages, because only the first is fixed by serving the page over https.

The conversation gains a third view beside **Chat** and **Trajectory**: a
read-only **Sandbox** tab describing the session's environment. It reports the
backend, profile, runner image, sandbox ID, lifecycle state, start time, and
deletion deadline from the control plane's own record, plus what the machine
says about itself — hostname, distribution, kernel, architecture, CPU, memory,
uptime, and disk use for the workspace and the container filesystem. The
lifecycle half is always available. The machine half needs a live runner, so it
appears only while the sandbox is running with a runner attached.

Reading the tab never provisions, wakes, or counts as activity, so a hibernated
sandbox is described rather than started; that is the same rule the `@` file
index follows. The tab refreshes faster while a turn runs, because a turn is
when a sandbox is provisioned, woken, or replaced.

The **Settings → MCP** page adds remote Model Context Protocol servers over
Streamable HTTP. An enabled server's tools join the model's tool list as
`mcp__<serverName>__<tool>`, and its resources join the profile's shared
`mcp-resources` service, which dsh-base mounts. Each server picks one
authentication method in its dialog: **None**, **Bearer token**, or **OAuth**.
Switching methods drops the secrets of the old one.

A bearer token is sent as a static `Authorization: Bearer` header and is
write-only: the browser receives only whether a token is saved, never its
value.

**OAuth** is the MCP authorization flow: authorization code with PKCE, with
discovery (RFC 9728, RFC 8414) and dynamic client registration run by the MCP
SDK's `auth()` in the control plane (`src/mcp-oauth.ts`). Saving an OAuth
server, or its card's **Connect** / **Reauthenticate** button, opens the
server's sign-in in a new tab; only the authorization URL reaches the browser.
The authorization server returns the browser to
`/dsh-yawn/mcp/oauth/callback` on the origin the Settings page was opened on.
That route sits outside `/api`, because the return trip is a cross-site
navigation, which dsh's `/api` fence refuses and which carries no
`SameSite=Strict` session cookie. A single-use `state`, issued to an
authenticated Settings page and forgotten after ten minutes, is what ties the
request to a sign-in. The client registration, the access token, and any
refresh token are saved with the server and never leave the host. A server is
mounted with the access token as a bearer header while it is valid.

The control plane renews tokens itself, on a one-minute tick that starts
after boot: when an access token with a refresh token is within ten minutes
of expiry (or half its lifetime, if that is shorter), it runs the refresh
grant through the SDK's `auth()`, each request limited to 30 seconds, and
saves the new tokens, including a rotated refresh token, unless the server
was signed in again meanwhile. The mcp-client takes only static headers, so a
renewed token means a remount: the server's tools drop out for the length of
a handshake, and a call in flight at that moment fails. Renewal is left late
to keep that rare for tokens that last hours, such as Notion's; a token that
lasts minutes remounts every few minutes. A failed renewal is retried with a
delay that doubles from one minute to thirty. A refused refresh token
(`invalid_grant`) ends the renewals, and the access token is used until it
expires. A refused client (`invalid_client`) removes the sign-in, so the next
one registers a new client; a renewal never registers one itself. Each tick
then reconciles the mounts: an expired token unmounts the server and its card
asks for a sign-in again. A server that issues no refresh token, or no
`expires_in`, is never renewed. Changing the URL signs out,
because the sign-in authorizes the old server. The redirect URI
must be one the authorization server accepts, which for most servers means
HTTPS or a loopback address.

Each server shows as a card with its live status and an
Enabled switch; **Add server** and **Edit** open a dialog, and Delete asks
for confirmation. Adding, editing, disabling, or removing a server mounts or
unmounts its tools for new tool calls without restarting the host, and **Test
connection** probes an unsaved entry without saving it — its probe tools live
in the shared registry until the probe is disposed, so a session can see them
for that moment. A server that fails to connect is reported as `error` with
the reason the client reported, and **Retry** connects it again — the client
stops reconnecting on its own once its attempt budget runs out, so Retry is
the only way back short of a restart. A name may not contain `__` or end in
`_`, because those would make one server's tool prefix match another's. The
configuration lives in `stateDir/mcp.json`, owner-only like the rest of the
control plane's state, and never in a sandbox.

The same mount puts every server's tools into every agent, including the
stock `minimal` preset, whose composition is a complete persona and one
persistent shell. The bundle's `mcp-tool-exclusion` row keeps the shared
mounts and denies the MCP tool names (`mcp__*` and `dsh-mcp-resources`' three
shared tools) on the agents whose live composition is one of the presets
listed in its `excludedPresets` config (default `[minimal]`). It reads that
live preset from the agent-preset registry (`composedPreset`), not the session
header: the header records only the preset the session started with, while
the Web UI picks a preset for a blank session through `agentPresets.select`,
which rebinds the composition and emits `tools/change`. The row calls
`tools.restrict` inside `agent.ctx` so the mask is that agent's alone,
re-reads every live agent's preset on each `tools/change`, and recomputes the
exact-name deny list there too — a switched preset or a server added, removed,
reconnected, or changing its tool list updates live sessions without a
restart. `minimal`'s persona is `complete`, so the MCP prompt
sections are dropped by the assembly anyway; the row only needs to hide the
schemas. An excluded preset without a complete persona would still assemble
the `mcp-resource-servers` section, so the config is meant for shell-only
compositions.

The bundle also disables dsh's local shell permission presets and its file
policy line. The remote shell uses one fixed container boundary and does not
claim to enforce those per-command sandbox modes. Both halves of the preset
surface go: since 0.1.7 the Web settings row reads the presets through a
`permissionPresets` catalog Remote that the client mounts whether or not the
host row loaded, so with the service off the row would render an error rather
than disappear. The policy line would tell
the model it may write under the session workspace and name that workspace by
its host anchor path, which does not exist inside the sandbox; the model only
ever needs sandbox paths, and it learns its working directory, in sandbox
paths, from the working-directory line described below.

The right sidebar's **Files** and **Preview** tabs and the file cards under
each turn (`workspace-files`, `ui-sidebar-files`, `ui-sidebar-documentpreview`,
`ui-deliverables`) read the session workspace through dsh's filesystem service
from plain browser requests, outside any agent turn, while this package's
filesystem finds a session's sandbox through the agent that is asking. The
bundle keeps those stock rows and adds two of its own: `sandbox-workspace-files`
wraps the live `workspaceFiles` service so each request runs as the agent of the
session it names, and `sandbox-workspace-policy` publishes the `sandboxPolicy`
service those rows require, reporting the sandbox workspace, adding nothing to
the prompt, and answering every call as `danger-full-access` — in dsh, "run the
command as it is, with no extra file sandbox". The container is the boundary, so
there is nothing to add. The rows that would add one — the persistent shell
behind the shipped `minimal` preset, and the PTC runtime — wrap the command in
the host's `landlock-run` launcher under any other answer. No sandbox can run
that launcher, so the command fails instead of being confined. See the Terminal
tab paragraph below. Browsing a file behaves like any other request against the
session: it wakes a hibernated sandbox and counts as activity for the idle
timer. A deferred design in which browsing never wakes a sandbox was not
built. One cosmetic limit remains: the Files tab's header label
comes from the session `cwd` in the browser, so it shows the host anchor
directory while every entry under it is a sandbox path.

Inline images in the session log — the `![](path)` markdown the model writes
and the file-mention images, the full-size dialog a click on one opens, and
images in a Markdown file previewed in the right sidebar — are served by
dsh's authenticated `/api/file`
route, which also reads through the filesystem service from a plain browser
request. Unlike the sidebar, its URL carries no session id, only a path, so
there is no scope to wrap the way `sandbox-workspace-files` does, and the
exact route cannot be re-registered. The bundle's browser half adds the
identity to the image URL instead (`src/client/media-session.ts`): it
watches the document and, for each `/api/file` image, adds the session of
the view the image sits in — the stock conversation view and right sidebar
mark their roots with `data-conversation-session` and
`data-sidebar-right-session`, the same attributes dsh itself uses to find an
element's session — as the `dsh-yawn-session` query parameter. The
full-size image dialog is rendered straight under `document.body`, outside
every view, so it takes the session of the thumbnail just clicked, and only
when its URL is exactly that thumbnail's. The stock route reads only
`path`, and the inline images load lazily, so the rewritten URL is the only
one the browser requests for them. Each image names its own conversation,
so two tabs, or two sessions whose images share a path, stay apart. The `sandbox-media-route` row listens on the `connection/request`
waterfall — which the connection service runs after authenticating the
request — and, for `/api/file` GET and HEAD only, resolves that session to
its live agent and runs the rest of the dispatch inside
`agents.withInitiator`. The initiator travels down the request's own async
chain into the route handler and its `ctx.fs` calls, so the read reaches
exactly the sandbox that conversation uses, subagent lineage included
(sandbox identity is root-keyed).

Anything but a clean hit — another path or method, any other image outside
a view, a session that cannot be resolved — passes through, and
the stock route fails as it did before rather than read a guessed sandbox:
`/workspace/repository/...` exists in every sandbox, so a path alone never
names one. The rewrite depends on those attributes and on the dialog's
markup, which are implementation details of the pinned dsh release, not a
promised interface. The clean long-term fix is the session id in the route's own URL,
which is an upstream change.

The right sidebar's **Terminal** tab (`terminal-controller`,
`ui-sidebar-terminal`) opens an interactive shell in the session workspace. The
stock controller allocates it through `ctx.subprocess.spawnTerminal`, and this
package implements that seam over a bidirectional runner RPC that owns a real
PTY in the sandbox: a session leader with the PTY as its controlling terminal,
so the terminal driver owns signal generation, the foreground process group,
and the window size. Input, resize, foreground and activity queries, and
signals travel one way; output and one final exit status come back the other.
Ending the request stream runs a TERM-to-KILL ladder over the session's process
group and hangs up what remains. Like file browsing, the allocation reaches the
sandbox through the agent that is asking, so the bundle keeps the stock rows
and adds `sandbox-terminal-controller`, which wraps the live
`terminalController` service: shell discovery and terminal creation run inside
`agents.withInitiator(agent, ...)`, and each input or resize the terminal
accepts resets the session's idle timer, so a sandbox is not hibernated out
from under a terminal someone is typing in. Input and resize travel on the
`attach` stream's uplink, and the wrapper counts the `ack` frame the stock
controller sends back for each accepted command. Terminal output stays out of the agent transcript. The same seam is
what dsh's persistent-shell backend (`dsh-terminal-bash`, used by the shipped
`minimal` preset) waits on: that preset swaps the one-shot `bash` tool for a
persistent shell that opens its PTY through `ctx.subprocess.spawnTerminal`.
Before opening it, the backend reads `ctx.sandboxPolicy` and, for any answer but
`danger-full-access`, wraps the shell in the host's `landlock-run` launcher.
The sandbox has no such launcher, so every `minimal` command failed with ENOENT;
answering full access is what keeps the preset working. The shell still runs in
the sandbox, through this seam, like every other command.

The shipped `ptc` agent preset replaces direct tool calls with programs the
model writes, and `@deepseek-ai/dsh-ptc-runtime-node` runs each program in a
fresh Node child. That child has to be a process in the sandbox, and the
provider speaks its protocol over the extra byte channel dsh's subprocess
interface offers as `stdio.control: 'pipe'` — a socket at the child's file
descriptor 7, which no caller on the dsh host can create inside a sandbox. The
feature is therefore its own package, built the way the terminal one is and just
as removable, and named for what it serves rather than for the interface it
implements: `ptc.proto` declares a bidirectional `PtcService` on the runner's
tunnel, `runner/ptc` owns the sandbox half, and `src/ptc/` owns the control
plane's. Nothing in it allocates a PTY, and no one types into it. The runner
owns the child's end — a Unix socket pair, the descriptor laid out at fd 7,
`DSH_SUBPROCESS_CONTROL=pipe` in the environment — and relays bytes both ways
beside the command's output and exit status. `subprocess.ts` hands a spawn that
asked for the channel to `PtcPipe` the way it hands a terminal to
`TerminalPool`; deleting the three pieces and their handoffs — one line each in
`subprocess.ts`, `runner-client.ts`, `main.go`, plus the runner image's copy and
the row that names it — removes the feature and leaves every other command
untouched.

The provider has to be pointed at sandbox paths for both halves of what it
starts. Its bootstrap is resolved from its own package — a control-plane path no
sandbox has — and its Node executable defaults to the control plane's own
`process.execPath`, which a sandbox has only by coincidence. The runner image
ships the compatible bootstrap (see `runner/Dockerfile`; a control-plane test
keeps its version equal to the dsh pin, because a copy from another release
fails the handshake at the first frame), and the `ptc-runtime` row's `launch`
names that copy as `bootstrapPath` and asks for the bare `node` on the
sandbox's own `PATH`. Since dsh 0.2.1 those fields sit under `launch`; the
provider ignores unknown top-level keys, so a stale row would silently fall
back to the control-plane paths. The row keeps the default `per-call` mode:
`persistent-in-memory` needs a second bootstrap the image does not ship. The trade is deliberate: the runner image carries one dsh file and
follows dsh's release, and in exchange the runtime keeps no version to
reconcile. The Docker smoke test drives a real run through the channel, because
only a sandbox proves the descriptor and the marker.

The header's **Open in...** button (`open-in-app`, `ui-open-in-app`) is off:
it launches a desktop application on the host against the session `cwd`.
That `cwd` is the anchor, and the application probe would run through the
sandbox subprocess seam and report programs installed in the sandbox.

Since dsh 0.2.1 one service, `workingDirectory`, owns each session's current
directory. Tools take their cwd from it, every model request carries it as a
"Current working directory" line, and the `working_directory` tool changes it.
It starts from the session `cwd`, which is the anchor, so the model would be
told a host path that a shell `cd` cannot reach. The bundle keeps the stock
row and adds `sandbox-working-directory`, which wraps the live service: `get`
maps the anchor and anything under it onto the sandbox workspace, so the
prompt line, the tool, the shells, and the Terminal tab all name sandbox paths.
Its checks read the sandbox filesystem, so they run as the agent they serve.
The composer's skill list also asks for the directory of an open session,
from a plain browser request; there the wrapper answers the recorded directory
without checking it, so viewing a session does not wake its sandbox.

The bundle also corrects the model-facing system prompt. Since dsh 0.2.1 the
Web bundle's `harness-dev-context` row tells the model the host's dsh
implementation checkout and the Web GUI URL, with guidance for changing dsh
itself; none of it holds inside a sandbox, so the bundle disables that row,
the way dsh's own README suggests. The `sandbox-context` row shadows the `cwd`
prompt variable with the sandbox workspace, answers the artifacts folder
beside it and what the session's backend keeps across a sleep as two more
prompt variables, and contributes a short environment section naming the
sandbox mount, the durable output folder, and the GUI paragraph's still-true
claim about what "this page" means. A patch entry for a row id that no longer
exists is skipped with only a warning, so a test downloads the pinned
`@deepseek-ai/dsh-web-app` and fails CI if it stops mounting
`harness-dev-context`.

The bundle also serves skills authored in this package. dsh's stock local
provider discovers skills from disk, and this package's filesystem seam reads
that disk inside the sandbox, so a `SKILL.md` under `$DSH_HOME/skills` on the
host is never seen by a sandboxed session: the path does not exist in the pod.
The `skills` row instead registers a provider over the TypeScript modules in
[`src/skills/`](src/skills/) into the global layer of dsh's skill registry,
which every agent's merged catalog carries.

A skill is a folder: an `index.ts` exporting an `AuthoredSkill` and a
`SKILL.md` beside it, listed in `src/skills/index.ts`. The list is explicit
rather than a directory scan, because a scan of TypeScript sources can only
find compiled files and would leave the catalog silently empty when the layout
changes. An unlisted folder is not served, and a listed one fails as it loads
if its import does not resolve or its `SKILL.md` is missing, so a mistake names
its path instead of appearing as a skill that lists but cannot be read. The
build copies the bodies into `dist`, and the served bodies are held in host
memory, so no machine's disk is read at session time. Authored skills take the
bundled rank, so a repository's own `.agents/skills` still wins a name
collision. dsh's `minimal` agent preset mounts no skill tool, so a session on
it sees no catalog regardless.

Two skills ship. `using-agent-browser` covers driving a browser from a
session: `install-browser` once per sandbox, then the CLI. The runner image
carries both commands; Chrome, the libraries it links against, and the font it
draws with are larger than the rest of the image, so `install-browser` adds
them on demand, into the workspace volume so a wake keeps them. The script
ships in the image rather than in the skill body, which keeps the body short
and pins the script to the image the session is running. The skill writes media
to the session's artifacts folder, defined under
[Idle and hibernation](README.md#idle-and-hibernation).

`attaching-media-to-github` covers `gh --attach`, which uploads images and
videos into issues, pull requests, and comments. The flag is newer than most
models' training data, so without the skill a session commits screenshots to a
side branch and links them. It needs gh 2.99.0 or later, which the runner image
provides.

Two modules are not part of the bundle patch. `@zhming0/dsh-yawn/auth` is the
built-in sign-in used by the Helm chart. When the `DSH_YAWN_OIDC_*` names
configure a provider, it runs the OIDC authorization-code flow with PKCE, keeps
a signed authority-bound session cookie, and wraps the live connection:
`authorizeIndex` serves the document only to a valid session, and `admit`
returns the browser Peer for that session while refusing dsh's launch-token
cookie and `/connect` token. It preserves dsh's Host/Origin fence by calling the
stock admission first, then refuses every credential that is not this session.
It also makes `authenticatedUrl` return the clean URL, so the control plane does
not print a token. The browser-session signing secret is a `sandbox-auth` record
in the credential store, and the row is mounted only when the image entrypoint
sees `DSH_YAWN_OIDC_ISSUER`.

`@zhming0/dsh-yawn/launch-token` remains the no-provider shortcut. Mounted as a
row, it serves `GET /launch-token`, which redirects the browser to dsh's
tokenized login URL so a port-forward user never reads the token from the host
log. It is not a sign-in: anyone who reaches dsh's port can use it, so the row
is off by default and the image mounts it only when
`DSH_YAWN_CONTROL_PLANE_LAUNCH_TOKEN_ROUTE=1` is set without an OIDC provider.
To mount either row yourself, insert it in a patch layer:

```yaml
- insert:
    - id: sandbox-auth
      name: "@zhming0/dsh-yawn/auth"

    - id: sandbox-launch-token
      name: "@zhming0/dsh-yawn/launch-token"
```

One module rides in the bundle patch itself: `@zhming0/dsh-yawn/owns-host`.
It injects `__DSH_TRANSPORT__ = { ownsHost: true }` into the served index, which
tells the web client the page is served by the dsh host — always true for this
distribution — so client settings persist to the host on any address. Without
it, dsh's client treats a non-loopback page (an Ingress name, a LAN address) as
untrusted for settings and keeps them in browser memory, and the
model-provider page fails with "settings are unavailable in this browser"; that
is why editing model credentials used to require `kubectl port-forward`. The
injection grants no access: `/api` keeps the same Host/Origin fence and the
same authentication. `tests/ui-owns-host.test.ts` pins the two dsh-internal
seams this rides on, so a dsh bump that moves either fails CI.

The image runs dsh as its own uid 1000 user. Its entrypoint starts as root only
long enough to read the mounted Docker socket's group and join it, then drops
root before seeding the profile or starting anything. A socket's group id only
means something inside the container it is mounted into — rootless or
userns-remapped Docker does not map the host-side value at all — so the lookup
belongs in the image and the run command needs no `--group-add`. A pod that sets
`runAsUser`, as the Helm chart does, skips the drop and never starts as root.

`DSH_YAWN_BIND_ALL=1` binds the Web UI to the container's own address
(`hostname -i`) so a published port reaches it; dsh refuses wildcard addresses
such as `0.0.0.0`. The chart sets it when built-in sign-in is enabled so the
Service can reach the pod; without a provider it stays unset and dsh remains on
pod loopback for `kubectl port-forward`.

The default backend uses Docker on the same machine as dsh. The Kubernetes
backend uses Kubernetes SIG agent-sandbox. The Buildkite backend runs each
sandbox as one build on a pipeline you create. Runners connect out to the host's
tunnel listener, so the host never dials into a sandbox; it only needs to be
reachable by the runners it manages. The tunnel is a WebSocket, so an HTTPS
proxy or Ingress can carry it next to the Web UI; see
[Tunnel](README.md#tunnel) below.

A host can offer several **sandbox profiles**. A profile is a complete
description of one kind of sandbox: which backend provisions it and that
backend's settings, such as a runner image for Docker or a warm pool for
Kubernetes. When more than one profile is
configured, a chip in the composer's tool row lets the user pick one for a new
