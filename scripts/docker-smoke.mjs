#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { promisify } from "node:util";

import { DockerBackend } from "../control-plane/dist/backends/docker.js";
import { previewHost } from "../control-plane/dist/preview.js";
import { PreviewServer } from "../control-plane/dist/preview-server.js";
import { TunnelServer } from "../control-plane/dist/tunnel.js";

const execFileAsync = promisify(execFile);

/** Run one `docker` subcommand, for the checks the backend cannot express. */
const docker = (arguments_) => execFileAsync("docker", arguments_);

const image = process.env.DSH_YAWN_RUNNER_IMAGE ?? "dsh-yawn-runner:dev";
const workspace = "/workspace/repository";
/** The preview domain the smoke's listener serves; resolution never happens. */
const PREVIEW_DOMAIN = "sandbox.localhost";
const registrationToken = randomBytes(32).toString("hex");
const tunnel = new TunnelServer({
  port: 0,
  tokens: [registrationToken],
  log: (message) => process.stdout.write(`${message}\n`),
});
await tunnel.listen();
const backend = new DockerBackend({
  image,
  controlPlaneUrl: `ws://host.docker.internal:${tunnel.port()}/tunnel`,
  registrationToken,
});
let handle;
let previewServer;

try {
  handle = await backend.provision({
    sessionId: `smoke-${Date.now()}`,
    repositoryUrl: "https://github.com/example/unused.git",
  });

  let client = await waitForRunner(tunnel, handle.sandboxId);
  await client.setSecrets({ SMOKE_VALUE: "present" });
  await assertSandboxStatus(client);
  // Tool presence, plus the `--attach` flag: Debian's gh predates it, so the
  // image installs a pinned release instead of the apt package.
  await run(client, [
    "/bin/bash",
    "-lc",
    'test "$SMOKE_VALUE" = present && git --version && jj --version && mise --version && python --version && uv --version && uvx --version && node --version && npm --version && jq --version && yq --version && gh --version && gh issue comment --help | grep -q -- --attach && docker --version && docker buildx version && docker compose version && for command in cc make pkg-config unzip zip xz file patch ssh rsync ps gh pnpm yarn agent-browser install-browser sudo; do command -v "$command" || exit 1; done && ! command -v pip && ! command -v dockerd && ! command -v containerd',
  ]);

  // The PTC bootstrap has to be in the sandbox the session runs: the provider
  // resolves it in the execution world, so the image carries the pinned copy and
  // the bundle patch names it.
  await run(client, [
    "/bin/bash",
    "-lc",
    "test -s /opt/dsh-yawn/ptc-runtime-node/process.js",
  ]);

  // A repository setup hook may install system packages, so the sandbox user
  // must reach root with sudo and no password. The Kubernetes smoke checks the
  // same rule under its pod security context; this container checks the rule
  // itself.
  const sudoUid = (await run(client, ["sudo", "-n", "id", "-u"])).trim();
  if (sudoUid !== "0") {
    throw new Error(`sudo did not reach root: ${sudoUid}`);
  }

  await assertPtcPipe(client);

  // The browser is deliberately not in the image; `install-browser`, which the
  // image does carry, adds it on demand. This runs that command for real and
  // then proves Chrome renders a page, so a broken installer or a missing
  // library fails here rather than in a session.
  await run(client, [
    "/bin/bash",
    "-lc",
    "! command -v google-chrome",
  ]);
  await client.writeFile({
    path: "/tmp/verify-browser.mjs",
    content: new TextEncoder().encode(
      readFileSync(
        new URL("./verify-browser.mjs", import.meta.url),
        "utf8",
      ),
    ),
    guard: { case: "createIfAbsent", value: true },
  });
  await run(client, ["/bin/bash", "-lc", "node /tmp/verify-browser.mjs"]);
  // Commands run as login shells, and Debian's /etc/profile resets PATH.
  // The image must restore the workspace install directories, and npm must
  // write global installs under $HOME, or `npm install -g` fails with EACCES.
  // mise must use its default data directory, not an override.
  await run(client, [
    "/bin/bash",
    "-lc",
    'case ":$PATH:" in *":$HOME/.local/share/mise/shims:"*) ;; *) exit 1 ;; esac && case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) exit 1 ;; esac && test -z "${MISE_DATA_DIR:-}" && test "$(npm config get prefix)" = "$HOME/.local"',
  ]);

  const home = (await run(client, ["sh", "-c", 'printf %s "$HOME"'])).trim();
  if (home !== "/workspace/home") {
    throw new Error(`unexpected home directory: ${home}`);
  }
  await run(client, [
    "sh",
    "-c",
    'printf "home survived" > "$HOME/home-sentinel"',
  ]);

  // The `using-agent-browser` skill writes media here. It is on the workspace
  // volume but outside the checkout, so a wake keeps it and a capture never
  // shows up as an untracked file in a repository.
  await run(client, [
    "sh",
    "-c",
    'mkdir -p /workspace/.agents/artifacts && printf "media" > /workspace/.agents/artifacts/smoke-sentinel',
  ]);
  const artifactsSentinel = (
    await run(client, ["cat", "/workspace/.agents/artifacts/smoke-sentinel"])
  ).trim();
  if (artifactsSentinel !== "media") {
    throw new Error(
      `artifacts directory is not writable: ${artifactsSentinel}`,
    );
  }

  await run(client, ["mkdir", "-p", `${workspace}/.git`, `${workspace}/.agents`]);
  await client.writeFile({
    path: `${workspace}/mise.toml`,
    content: new TextEncoder().encode('[tools]\nnode = "24.19.0"\n'),
    guard: { case: "createIfAbsent", value: true },
  });
  await run(client, ["mise", "install"], workspace);
  const nodeVersion = await run(client, ["node", "--version"], workspace);
  if (nodeVersion.trim() !== "v24.19.0") {
    throw new Error(`mise installed unexpected Node version: ${nodeVersion.trim()}`);
  }
  await client.writeFile({
    path: `${workspace}/.agents/setup`,
    content: new TextEncoder().encode(
      `#!/bin/sh\nset -eu\nprintf 'x' >> ${workspace}/.setup-runs\nprintf 'workspace survived' > ${workspace}/sentinel\n`,
    ),
    guard: { case: "createIfAbsent", value: true },
  });
  await run(client, ["chmod", "+x", `${workspace}/.agents/setup`]);
  const firstSetup = await client.setup({
    repositoryUrl: "https://github.com/example/unused.git",
    revision: "",
    workspace,
  });
  if (!firstSetup.ran) throw new Error("first setup did not run");
  if ((await readText(client, `${workspace}/.setup-runs`)) !== "x") {
    throw new Error("the setup hook did not record exactly one run");
  }
  if (
    (await readText(client, "/var/lib/dsh-yawn/setup-done")) !== "complete\n"
  ) {
    throw new Error("the setup marker is not on the machine");
  }

  // Hibernation kills the tunnel socket; on wake the runner dials back in. The
  // container is the same machine, so its setup marker survived and setup must
  // not run again.
  await backend.hibernate(handle.reference);
  tunnel.drop(handle.sandboxId);
  handle = await backend.wake(handle.reference);
  client = await waitForRunner(tunnel, handle.sandboxId);
  const secondSetup = await client.setup({
    repositoryUrl: "https://github.com/example/unused.git",
    revision: "",
    workspace,
  });
  if (secondSetup.ran) {
    throw new Error("setup re-ran on a machine that kept its marker");
  }
  if (await readText(client, `${workspace}/.setup-runs`) !== "x") {
    throw new Error("setup ran more than once on one machine");
  }
  const sentinel = await client.readFile({
    path: `${workspace}/sentinel`,
    maxBytes: 1024n,
  });
  if (new TextDecoder().decode(sentinel.content) !== "workspace survived") {
    throw new Error("workspace content did not survive hibernation");
  }
  const homeSentinel = await client.readFile({
    path: `${home}/home-sentinel`,
    maxBytes: 1024n,
  });
  if (new TextDecoder().decode(homeSentinel.content) !== "home survived") {
    throw new Error("home directory content did not survive hibernation");
  }
  const artifactsAfterWake = await client.readFile({
    path: "/workspace/.agents/artifacts/smoke-sentinel",
    maxBytes: 1024n,
  });
  if (new TextDecoder().decode(artifactsAfterWake.content) !== "media") {
    throw new Error("artifacts outside the checkout did not survive hibernation");
  }
  const nodeVersionAfterWake = await run(
    client,
    ["node", "--version"],
    workspace,
  );
  if (nodeVersionAfterWake.trim() !== "v24.19.0") {
    throw new Error("mise-managed tools did not survive hibernation");
  }

  // A Kubernetes wake builds a new machine around the workspace volume, and
  // the new machine must run setup again. Docker's own backend keeps its
  // container, so two containers sharing a named volume stand in for that
  // rebuild here.
  await assertNewMachineRunsSetupAgain(tunnel, image, registrationToken);

  // The preview listener: a server started by a session command, reached by
  // host name. setsid detaches it from the exec process group so it outlives
  // the command that started it.
  previewServer = new PreviewServer({
    domain: PREVIEW_DOMAIN,
    port: 0,
    bind: "127.0.0.1",
    gateway: tunnel,
    log: (message) => process.stdout.write(`${message}\n`),
  });
  await previewServer.listen();
  await client.writeFile({
    path: "/workspace/preview-marker.txt",
    content: new TextEncoder().encode("preview live"),
    guard: { case: "createIfAbsent", value: true },
  });
  await client.writeFile({
    path: "/tmp/preview-server.py",
    content: new TextEncoder().encode(
      readFileSync(new URL("./preview-server.py", import.meta.url), "utf8"),
    ),
    guard: { case: "createIfAbsent", value: true },
  });
  await run(client, [
    "/bin/bash",
    "-lc",
    "setsid python3 /tmp/preview-server.py >/tmp/http.log 2>&1 &",
  ]);
  // The command above returns before Python binds its socket. Wait for the
  // sandbox's own listener first, so the assertion below tests the relay
  // rather than how fast Python starts on a loaded machine.
  await run(client, [
    "/bin/bash",
    "-c",
    "for _ in $(seq 1 150); do (exec 3<>/dev/tcp/127.0.0.1/3123) 2>/dev/null && exit 0; sleep 0.1; done; echo 'the preview server never listened on 3123:' >&2; cat /tmp/http.log >&2; exit 1",
  ]);
  const preview = await requestByHost(
    previewServer.port(),
    previewHost(PREVIEW_DOMAIN, handle.sandboxId, 3123),
    "/preview-marker.txt",
  );
  if (preview.status !== 200 || preview.body !== "preview live") {
    throw new Error(
      `preview listener answered ${preview.status} with ${JSON.stringify(preview.body)}`,
    );
  }
  // A preview is its own origin, so the sandbox server's cookie and policy
  // are its own and must arrive untouched.
  if (preview.headers["set-cookie"]?.join(", ") !== "sandbox=1") {
    throw new Error(
      `preview listener lost the sandbox's cookie: ${preview.headers["set-cookie"]}`,
    );
  }
  if (preview.headers["content-security-policy"] !== "default-src 'none'") {
    throw new Error(
      `preview listener touched the sandbox's policy: ${preview.headers["content-security-policy"]}`,
    );
  }
  // A host outside the preview domain is an unknown host, not a dial.
  const foreign = await requestByHost(
    previewServer.port(),
    "other.example.com",
    "/",
  );
  if (foreign.status !== 404) {
    throw new Error(
      `preview listener answered a foreign host: ${foreign.status}`,
    );
  }

  process.stdout.write("PASS: Docker runner registration, tools, setup, and hibernate/wake\n");
} finally {
  if (handle !== undefined) await backend.destroy(handle.reference).catch(() => {});
  if (previewServer !== undefined) await previewServer.close().catch(() => {});
  await tunnel.close();
}

/**
 * One HTTP request naming a host the listener never resolves. fetch refuses a
 * custom Host header (it is a forbidden header name), so this is plain http.
 */
function requestByHost(port, host, path) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: "127.0.0.1", port, path, headers: { host } },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

/**
 * A machine rebuilt around the same workspace volume runs setup again, because
 * the marker lives on the machine and not on the volume. The two containers
 * here are plain `docker run`s: the backend's own container has no volume, and
 * its hibernate/wake keeps the machine, which the earlier checks cover.
 */
async function assertNewMachineRunsSetupAgain(
  tunnel,
  image,
  registrationToken,
) {
  const suffix = Date.now();
  const volume = `dsh-smoke-volume-${suffix}`;
  const sandboxId = `dsh-smoke-machine-${suffix}`;
  const container = (name) => `dsh-smoke-machine-${suffix}-${name}`;
  const start = (name) =>
    docker([
      "run",
      "--detach",
      "--name",
      container(name),
      "--user",
      "1000:1000",
      "--volume",
      `${volume}:/workspace`,
      "--add-host",
      "host.docker.internal:host-gateway",
      "--env",
      `DSH_YAWN_SANDBOX_ID=${sandboxId}`,
      "--env",
      `DSH_YAWN_CONTROL_PLANE_URL=ws://host.docker.internal:${tunnel.port()}/tunnel`,
      "--env",
      `DSH_YAWN_REGISTRATION_TOKEN=${registrationToken}`,
      image,
    ]);
  const setupRequest = {
    repositoryUrl: "https://github.com/example/unused.git",
    revision: "",
    workspace: "/workspace/repository",
  };
  try {
    await docker(["volume", "create", volume]);
    await start("one");
    let client = await waitForRunner(tunnel, sandboxId);
    await run(client, [
      "mkdir",
      "-p",
      "/workspace/repository/.git",
      "/workspace/repository/.agents",
    ]);
    await client.writeFile({
      path: "/workspace/repository/.agents/setup",
      content: new TextEncoder().encode(
        "#!/bin/sh\nset -eu\nprintf 'x' >> /workspace/repository/.setup-runs\n",
      ),
      guard: { case: "createIfAbsent", value: true },
    });
    await run(client, ["chmod", "+x", "/workspace/repository/.agents/setup"]);
    const first = await client.setup(setupRequest);
    if (!first.ran) {
      throw new Error("setup did not run on a fresh machine");
    }
    if ((await readText(client, "/workspace/repository/.setup-runs")) !== "x") {
      throw new Error("the setup hook did not record exactly one run");
    }

    // The machine goes away; only the volume stays.
    await docker(["rm", "--force", container("one")]);
    tunnel.drop(sandboxId);
    await start("two");
    client = await waitForRunner(tunnel, sandboxId);
    const second = await client.setup(setupRequest);
    if (!second.ran) {
      throw new Error("a new machine with the same volume did not run setup");
    }
    if ((await readText(client, "/workspace/repository/.setup-runs")) !== "xx") {
      throw new Error("setup did not run once per machine");
    }
  } finally {
    await docker(["rm", "--force", container("one"), container("two")]).catch(
      () => {},
    );
    await docker(["volume", "rm", "--force", volume]).catch(() => {});
    tunnel.drop(sandboxId);
  }
}

/** Read a small file through the runner, for an assertion. */
async function readText(client, path) {
  const file = await client.readFile({ path, maxBytes: 4096n });
  return new TextDecoder().decode(file.content);
}

async function waitForRunner(tunnel, sandboxId) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const client = await tunnel.waitFor(sandboxId, deadline - Date.now());
      const health = await client.health({ timeoutMs: 2_000 });
      if (health.sandboxId !== sandboxId) {
        throw new Error(`runner identity mismatch: got ${health.sandboxId}`);
      }
      return client;
    } catch (error) {
      lastError = error;
      tunnel.drop(sandboxId);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`runner did not become ready: ${String(lastError)}`);
}

/**
 * The Sandbox tab reads these facts from the runner. A regression in the
 * runner or in the generated contract should fail here, not in the UI.
 */
async function assertSandboxStatus(client) {
  const status = await client.sandboxStatus({ timeoutMs: 10_000 });
  if (status.sandboxId.length === 0) {
    throw new Error("SandboxStatus returned no sandbox id");
  }
  if (status.hostname.length === 0) {
    throw new Error("SandboxStatus returned no hostname");
  }
  if (status.osName.length === 0 || status.kernelVersion.length === 0) {
    throw new Error("SandboxStatus returned no OS facts");
  }
  if (status.cpuCount < 1) {
    throw new Error(`SandboxStatus returned ${status.cpuCount} CPUs`);
  }
  if (status.memoryTotalBytes <= 0n || status.filesystemDiskTotalBytes <= 0n) {
    throw new Error("SandboxStatus returned no memory or disk size");
  }
  process.stdout.write(`sandbox status: ${status.hostname} (${status.osName})\n`);
}

async function run(client, argv, cwd = "/workspace") {
  let stdout = "";
  let stderr = "";
  let exited = false;
  for await (const response of client.exec({
    argv,
    cwd,
    env: {},
    stdin: new Uint8Array(),
  })) {
    if (response.event.case === "stdout") {
      const chunk = new TextDecoder().decode(response.event.value);
      stdout += chunk;
      process.stdout.write(chunk);
    }
    if (response.event.case === "stderr") {
      stderr += new TextDecoder().decode(response.event.value);
    }
    if (response.event.case === "exited") {
      exited = true;
      if (
        response.event.value.exitCode !== 0 ||
        response.event.value.signal !== ""
      ) {
        const status =
          response.event.value.signal === ""
            ? `exit ${response.event.value.exitCode}`
            : `signal ${response.event.value.signal}`;
        throw new Error(`command failed with ${status}: ${stderr}`);
      }
    }
  }
  if (!exited) throw new Error("command stream ended without an exit status");
  return stdout;
}

/**
 * Drive one PTC run through a real sandbox. The child adopts file descriptor 7
 * the way `openInheritedControlChannel()` does and echoes what it reads, which
 * proves the descriptor, the launch marker, and both directions of the channel
 * together: the bootstrap the image ships (checked above) cannot handshake
 * without it.
 */
async function assertPtcPipe(client) {
  const program = [
    'import { Socket } from "node:net";',
    "const stream = new Socket({",
    "  fd: 7,",
    "  readable: true,",
    "  writable: true,",
    "  allowHalfOpen: true,",
    "});",
    "console.log(`marker:${process.env.DSH_SUBPROCESS_CONTROL}`);",
    'stream.on("data", (chunk) => stream.write(chunk));',
    'stream.write("ready\\n");',
    "",
  ].join("\n");
  await client.writeFile({
    path: "/tmp/ptc-pipe-smoke.mjs",
    content: new TextEncoder().encode(program),
    guard: { case: "createIfAbsent", value: true },
  });

  const toSend = [];
  let wake;
  const requests = (async function* () {
    yield {
      message: {
        case: "start",
        value: {
          argv: ["node", "/tmp/ptc-pipe-smoke.mjs"],
          cwd: "/workspace",
          env: {},
          stdin: new Uint8Array(),
        },
      },
    };
    while (true) {
      if (toSend.length === 0) {
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
      yield { message: { case: "control", value: toSend.shift() } };
    }
  })();
  const send = (text) => {
    toSend.push(new TextEncoder().encode(text));
    wake?.();
    wake = undefined;
  };

  const decoder = new TextDecoder();
  let stdout = "";
  let stderr = "";
  let control = "";
  let asked = false;
  for await (const response of client.ptc.run(requests)) {
    if (response.event.case === "stdout") {
      stdout += decoder.decode(response.event.value);
    }
    if (response.event.case === "stderr") {
      stderr += decoder.decode(response.event.value);
    }
    if (response.event.case === "control") {
      control += decoder.decode(response.event.value);
      if (!asked && control.includes("ready\n")) {
        asked = true;
        send("ping");
      }
      if (control.includes("ping")) {
        // The echo arrived. Ending the call is the termination the PTC runtime
        // performs once its program has settled.
        break;
      }
    }
  }
  if (!stdout.includes("marker:pipe")) {
    throw new Error(
      `the child did not inherit the PTC marker: stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
    );
  }
  if (!control.includes("ping")) {
    throw new Error(
      `the PTC channel did not echo: control=${JSON.stringify(control)} stderr=${JSON.stringify(stderr)}`,
    );
  }
  process.stdout.write("ptc pipe: ok\n");
}
