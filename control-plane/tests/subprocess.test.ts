import { describe, expect, it } from "vitest";
import { Duplex, type Readable } from "node:stream";

import { Code, ConnectError } from "@connectrpc/connect";
import { Context } from "@deepseek-ai/cordis";
import {
  SubprocessExecutableNotFoundError,
  type SubprocessSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";

import type {
  PtcRunRequestMessage,
  RunnerClient,
} from "../src/runner-client.js";
import { SandboxSubprocessRuntime, testing } from "../src/subprocess.js";

const SESSION_WORKSPACE = "/data/.dsh-yawn/workspace-anchors/owner-repo";
const SANDBOX_WORKSPACE = "/workspace/repository";
const PACKAGED_RG =
  "/data/.dsh/profiles/web/node_modules/@vscode/ripgrep/bin/rg";

interface ExecRequest {
  argv: string[];
  cwd?: string;
  env: Record<string, string>;
  stdin: Uint8Array;
}

interface FakeRunnerOptions {
  /** Absolute paths the fake runner's ResolveExecutable answers with itself. */
  existing?: string[];
  /** Bare names resolvable against the runner PATH, mapped to their paths. */
  onPath?: Record<string, string>;
  /** What a lookup miss rejects with; the runner's own `not found` by default. */
  miss?: Error;
}

function fakeRunnerClient(
  requests: ExecRequest[],
  resolves: string[],
  options: FakeRunnerOptions = {},
): RunnerClient {
  return {
    resolveExecutable({ command }: { command: string }) {
      resolves.push(command);
      if ((options.existing ?? []).includes(command)) {
        return Promise.resolve({ path: command });
      }
      if ((options.onPath ?? {})[command] !== undefined) {
        return Promise.resolve({ path: options.onPath![command]! });
      }
      return Promise.reject(options.miss ?? new Error("executable not found"));
    },
    // RemoteProcess consumes one request per exec and only needs the exit.
    async *exec(request: ExecRequest) {
      requests.push(request);
      yield { event: { case: "started", value: { pid: 7n } } };
      yield { event: { case: "exited", value: { exitCode: 0, signal: "" } } };
    },
  } as unknown as RunnerClient;
}

/**
 * A runner that answers one PTC run: it records every request message and
 * echoes each channel write back as a control event, until the caller ends its
 * request half.
 */
function fakePtcRunnerClient(messages: PtcRunRequestMessage[]): RunnerClient {
  return {
    resolveExecutable: () => Promise.reject(new Error("not needed")),
    ptc: {
      async *run(request: AsyncIterable<PtcRunRequestMessage>) {
        for await (const message of request) {
          messages.push(message);
          const body = message.message;
          if (body?.case === "start") {
            yield { event: { case: "started", value: { pid: 7n } } };
            continue;
          }
          if (body?.case === "control") {
            yield { event: { case: "control", value: body.value } };
          }
        }
        yield { event: { case: "exited", value: { exitCode: 0, signal: "" } } };
      },
    },
  } as unknown as RunnerClient;
}

function runtimeWith(
  client: RunnerClient,
  sessionWorkspace = SESSION_WORKSPACE,
): SandboxSubprocessRuntime {
  const ctx = {
    ...new Context(),
    // Prototype methods (effect) do not survive the spread; the runtime only
    // registers its disposal effect, which a no-op stands in for here.
    effect: () => async () => {},
    sandboxManager: {
      clientForCurrentAgent: async () => client,
      workspace: SANDBOX_WORKSPACE,
    },
    agents: {
      requireInitiator: () => ({
        session: { header: { cwd: sessionWorkspace } },
      }),
    },
  };
  return new SandboxSubprocessRuntime(
    ctx as unknown as ConstructorParameters<typeof SandboxSubprocessRuntime>[0],
  );
}

/** Read one output stream to its end, the way a consumer does. */
async function readToEnd(stream: Readable): Promise<number> {
  let bytes = 0;
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    bytes += chunk.byteLength;
  }
  return bytes;
}

function spawn(
  runtime: SandboxSubprocessRuntime,
  overrides: Partial<SubprocessSpawnSpec>,
): Promise<unknown> {
  const spec = {
    argv: ["/usr/local/bin/rg", "--files"],
    cwd: SANDBOX_WORKSPACE,
    stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    ...overrides,
  } as SubprocessSpawnSpec;
  return runtime.spawn(spec).done;
}

describe("sandbox subprocess seam", () => {
  it("maps a session-frame workdir onto the sandbox workspace", async () => {
    const requests: ExecRequest[] = [];
    const client = fakeRunnerClient(requests, []);
    await spawn(runtimeWith(client), { cwd: `${SESSION_WORKSPACE}/nested` });
    expect(requests[0]?.cwd).toBe(`${SANDBOX_WORKSPACE}/nested`);
  });

  it("leaves sandbox-frame workdirs unchanged", async () => {
    const requests: ExecRequest[] = [];
    const client = fakeRunnerClient(requests, []);
    await spawn(runtimeWith(client), { cwd: `${SANDBOX_WORKSPACE}/nested` });
    expect(requests[0]?.cwd).toBe(`${SANDBOX_WORKSPACE}/nested`);
  });

  it("maps session-frame argv paths onto the sandbox workspace", async () => {
    const requests: ExecRequest[] = [];
    const client = fakeRunnerClient(requests, [], {
      existing: ["/usr/local/bin/rg"],
    });
    // The stock grep row: session cwd, a --flag=value pair, and the model's
    // absolute search root behind `--`.
    await spawn(runtimeWith(client), {
      argv: [
        "/usr/local/bin/rg",
        "--json",
        "--regexp=TODO",
        "--glob=*.ts",
        "--",
        `${SESSION_WORKSPACE}/src`,
      ],
      cwd: SESSION_WORKSPACE,
    });
    expect(requests[0]?.argv).toEqual([
      "/usr/local/bin/rg",
      "--json",
      "--regexp=TODO",
      "--glob=*.ts",
      "--",
      `${SANDBOX_WORKSPACE}/src`,
    ]);
    expect(requests[0]?.cwd).toBe(SANDBOX_WORKSPACE);
  });

  it("leaves relative, sandbox-frame, and foreign absolute argv values unchanged", async () => {
    const requests: ExecRequest[] = [];
    const client = fakeRunnerClient(requests, [], {
      existing: ["/usr/local/bin/rg"],
    });
    await spawn(runtimeWith(client), {
      argv: [
        "/usr/local/bin/rg",
        "--files",
        "--",
        "src",
        `${SANDBOX_WORKSPACE}/lib`,
        "/etc/hosts",
        `${SESSION_WORKSPACE}-other/src`,
      ],
    });
    expect(requests[0]?.argv).toEqual([
      "/usr/local/bin/rg",
      "--files",
      "--",
      "src",
      `${SANDBOX_WORKSPACE}/lib`,
      "/etc/hosts",
      `${SESSION_WORKSPACE}-other/src`,
    ]);
  });

  it("runs a session-frame executable from its sandbox path without a lookup", async () => {
    const requests: ExecRequest[] = [];
    const resolves: string[] = [];
    const client = fakeRunnerClient(requests, resolves);
    await spawn(runtimeWith(client), {
      argv: [`${SESSION_WORKSPACE}/scripts/check.sh`],
    });
    expect(resolves).toEqual([]);
    expect(requests[0]?.argv).toEqual([
      `${SANDBOX_WORKSPACE}/scripts/check.sh`,
    ]);
  });

  it("resolves a host-only executable to the sandbox build of the same tool", async () => {
    const requests: ExecRequest[] = [];
    const resolves: string[] = [];
    const client = fakeRunnerClient(requests, resolves, {
      onPath: { rg: "/usr/local/bin/rg" },
    });
    await spawn(runtimeWith(client), {
      argv: [PACKAGED_RG, "--no-config", "--files"],
    });
    // The literal host path is tried first, then the basename.
    expect(resolves).toEqual([PACKAGED_RG, "rg"]);
    expect(requests[0]?.argv).toEqual([
      "/usr/local/bin/rg",
      "--no-config",
      "--files",
    ]);
  });

  it("keeps executables the sandbox already has at the given path", async () => {
    const requests: ExecRequest[] = [];
    const resolves: string[] = [];
    const client = fakeRunnerClient(requests, resolves, {
      existing: ["/usr/local/bin/rg"],
    });
    await spawn(runtimeWith(client), {
      argv: ["/usr/local/bin/rg", "--files"],
    });
    expect(resolves).toEqual(["/usr/local/bin/rg"]);
    expect(requests[0]?.argv).toEqual(["/usr/local/bin/rg", "--files"]);
  });

  it("keeps the original executable when nothing resolves, so the runner reports the failure", async () => {
    const requests: ExecRequest[] = [];
    const client = fakeRunnerClient(requests, []);
    await spawn(runtimeWith(client), { argv: ["/host-only/tool", "--flag"] });
    expect(requests[0]?.argv).toEqual(["/host-only/tool", "--flag"]);
  });

  it("does not canonicalize executables inside the sandbox workspace", async () => {
    const requests: ExecRequest[] = [];
    const resolves: string[] = [];
    const client = fakeRunnerClient(requests, resolves);
    await spawn(runtimeWith(client), {
      argv: [`${SANDBOX_WORKSPACE}/tool.sh`, "--flag"],
    });
    expect(resolves).toEqual([]);
    expect(requests[0]?.argv).toEqual([
      `${SANDBOX_WORKSPACE}/tool.sh`,
      "--flag",
    ]);
  });

  it("does not canonicalize bare or relative executables", async () => {
    const requests: ExecRequest[] = [];
    const resolves: string[] = [];
    const client = fakeRunnerClient(requests, resolves);
    await spawn(runtimeWith(client), { argv: ["rg", "--files"] });
    expect(resolves).toEqual([]);
    expect(requests[0]?.argv).toEqual(["rg", "--files"]);
  });
});

describe("sandbox PTC channel", () => {
  /** Spawn one command that asked for dsh's extra channel. */
  function spawnWithChannel(
    runtime: SandboxSubprocessRuntime,
    overrides: Partial<SubprocessSpawnSpec> = {},
  ) {
    const spec: SubprocessSpawnSpec = {
      argv: [`${SESSION_WORKSPACE}/program`, "--flag"],
      cwd: SESSION_WORKSPACE,
      stdio: {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        control: "pipe",
      },
      graceMs: 1_000,
      ...overrides,
    };
    return runtime.spawn(spec);
  }

  it("carries channel bytes both ways over the PTC RPC", async () => {
    const messages: PtcRunRequestMessage[] = [];
    const handle = spawnWithChannel(runtimeWith(fakePtcRunnerClient(messages)));
    const control = handle.control;
    expect(control).toBeInstanceOf(Duplex);

    const echoed = new Promise<Buffer>((resolve) =>
      control!.once("data", resolve),
    );
    control!.write(Buffer.from("ping"));
    await expect(echoed).resolves.toEqual(Buffer.from("ping"));
    // Closing the caller's endpoint ends the request half, and the runner's
    // exit status still arrives afterwards.
    control!.end();
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null });

    expect(messages.map((message) => message.message?.case)).toEqual([
      "start",
      "control",
    ]);
    // The start message speaks sandbox coordinates like every other spawn.
    expect(messages[0]?.message?.value).toMatchObject({
      argv: [`${SANDBOX_WORKSPACE}/program`, "--flag"],
      cwd: SANDBOX_WORKSPACE,
    });
    expect(messages[1]?.message?.value).toEqual(
      new Uint8Array([112, 105, 110, 103]),
    );
  });

  it("ends the output pipes when the run never starts", async () => {
    const messages: PtcRunRequestMessage[] = [];
    const handle = spawnWithChannel(runtimeWith(fakePtcRunnerClient(messages)));
    // The caller closed its endpoint before the run could start, so the spawn
    // fails in the seam rather than on the wire.
    handle.control?.destroy();

    await expect(handle.done).rejects.toThrow("closed before the command");
    // Reading to the end is what a consumer does; a pipe left open hangs here.
    await expect(readToEnd(handle.stdout!)).resolves.toBe(0);
    await expect(readToEnd(handle.stderr!)).resolves.toBe(0);
  });

  it("gives an ordinary spawn no control handle", async () => {
    const requests: ExecRequest[] = [];
    const handle = runtimeWith(fakeRunnerClient(requests, [])).spawn({
      argv: ["/usr/local/bin/rg"],
      cwd: SANDBOX_WORKSPACE,
      stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      graceMs: 1_000,
    });
    expect(handle.control).toBeUndefined();
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null });
    expect(requests).toHaveLength(1);
  });
});

describe("sandbox subprocess executable lookup", () => {
  it("reports a lookup miss with the runtime's own error type", async () => {
    const client = fakeRunnerClient([], [], {
      miss: new ConnectError("executable not found", Code.NotFound),
    });
    await expect(
      runtimeWith(client).resolveExecutable("/usr/bin/zsh"),
    ).rejects.toBeInstanceOf(SubprocessExecutableNotFoundError);
  });

  it("keeps a transport failure distinct from a lookup miss", async () => {
    const client = fakeRunnerClient([], [], {
      miss: new ConnectError("runner unavailable", Code.Unavailable),
    });
    await expect(
      runtimeWith(client).resolveExecutable("/usr/bin/zsh"),
    ).rejects.toMatchObject({ code: Code.Unavailable });
  });
});

describe("subprocess output buffers", () => {
  it("keeps a bounded output tail and reports loss", () => {
    const subprocess = new testing.CollectedBuffer(4);
    subprocess.append(new TextEncoder().encode("abcdef"));
    expect(subprocess.readFrom(0)).toEqual({
      text: "cdef",
      nextOffset: 6,
      lossy: true,
    });
  });
});
