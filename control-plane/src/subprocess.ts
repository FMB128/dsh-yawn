import { PassThrough, Writable, type Duplex, type Readable } from "node:stream";
import { basename, isAbsolute } from "node:path";

import { Code, ConnectError } from "@connectrpc/connect";
import {
  SubprocessExecutableNotFoundError,
  SubprocessRuntime,
  type SubprocessHandle,
  type SubprocessOutputReader,
  type SubprocessSpawnSpec,
  type SubprocessTerminalEnvironment,
  type SubprocessTerminalHandle,
  type SubprocessTerminalSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";
import type { Context } from "@deepseek-ai/cordis";

import { PtcPipe } from "./ptc/pipe.js";
import type { ExecRequest } from "./gen/dsh/yawn/v1/runner_pb.js";
import type { RunnerClient } from "./runner-client.js";
import {
  isInsideSandboxWorkspace,
  pathInSandbox,
  type PathFrames,
} from "./sandbox-path.js";
import { TerminalPool } from "./terminal/remote-terminal.js";

export class SandboxSubprocessRuntime extends SubprocessRuntime {
  static inject = ["sandboxManager", "agents"];
  private readonly live = new Set<RemoteProcess>();
  /** The sandbox terminal feature owns its sessions; this seam only holds them. */
  private readonly terminals = new TerminalPool();

  constructor(ctx: Context) {
    super(ctx);
    ctx.effect(() => async () => {
      for (const process of this.live) {
        process.terminate();
      }
      await Promise.allSettled([...this.live].map((process) => process.done));
      await this.terminals.terminateAll();
    });
  }

  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    const client = await this.ctx.sandboxManager.clientForCurrentAgent();
    try {
      const response = await client.resolveExecutable(
        { command, env: { ...env } },
        signal === undefined ? {} : { signal },
      );
      return response.path;
    } catch (error) {
      // The runner reports a completed lookup miss as `not found`, the way any
      // other Connect service does. `SubprocessRuntime` promises its own error
      // type for that case and its callers branch on it: terminal shell
      // discovery drops a candidate it cannot find but rethrows anything else.
      // Letting the transport error through would make one shell that is simply
      // absent look like a failed lookup and reject the whole listing.
      if (ConnectError.from(error).code === Code.NotFound) {
        throw new SubprocessExecutableNotFoundError(
          `sandbox: executable ${JSON.stringify(command)} was not found`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const process = new RemoteProcess(
      this.ctx.sandboxManager.clientForCurrentAgent(),
      spec,
      this.executionFrame(),
    );
    this.live.add(process);
    void process.done.finally(() => this.live.delete(process)).catch(() => {});
    return process;
  }

  /**
   * The two path frames one spawn translates between. Callers may speak
   * session coordinates (the dsh session workspace) because they were written
   * for the host world — the stock `tool-fs-search` row passes its session cwd,
   * a ripgrep path resolved from the host's own node_modules, and the model's
   * search root, which the model knows in session coordinates. The sandbox is
   * the execution world that has to answer, so the seam maps all of them onto
   * the sandbox the same way the shell and filesystem seams map their paths.
   */
  private executionFrame(): PathFrames {
    let sessionWorkspace: string | undefined;
    try {
      sessionWorkspace = this.ctx.agents.requireInitiator().session.header.cwd;
    } catch {
      // No foreground agent: nothing names session coordinates to translate.
    }
    return {
      sessionWorkspace,
      sandboxWorkspace: this.ctx.sandboxManager.workspace,
    };
  }

  /**
   * Allocate one interactive terminal in the session's sandbox. The runner
   * owns the PTY: the request stream carries input, resize, foreground and
   * activity queries, and signals, while the response stream carries output
   * and the exit status. Ending the request stream runs the runner's
   * termination ladder over the session's process group.
   *
   * The published handle captures the runner client at allocation, so opening
   * a terminal wakes a hibernated sandbox once and later keystrokes do not
   * need an agent boundary. The spec's signal cancels allocation only; it is
   * detached once the handle is published.
   *
   * The whole feature lives in `terminal/`, so a profile without the terminal
   * rows leaves this handoff and the pool it feeds unused.
   */
  spawnTerminal(
    spec: SubprocessTerminalSpawnSpec,
  ): Promise<SubprocessTerminalHandle> {
    return this.terminals.spawn(
      this.ctx.sandboxManager.clientForCurrentAgent(),
      spec,
      this.executionFrame(),
    );
  }

  async terminalEnvironment(
    _signal?: AbortSignal,
  ): Promise<SubprocessTerminalEnvironment> {
    // Every runner profile is a Linux image whose shell seam uses bash (see
    // the bash executor). Terminal requests on a non-Linux runner are refused
    // by the runner itself.
    return { platform: "posix", defaultShell: "/bin/bash" };
  }
}

class RemoteProcess implements SubprocessHandle {
  private processId = -1;
  private readonly controller = new AbortController();
  private readonly stdoutPipe: PassThrough | undefined;
  private readonly stderrPipe: PassThrough | undefined;
  private readonly stdoutCollection: CollectedBuffer | undefined;
  private readonly stderrCollection: CollectedBuffer | undefined;
  private readonly ptc: PtcPipe | undefined;
  readonly stdin: Writable | undefined;
  readonly control: Duplex | undefined;
  readonly done: Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>;

  constructor(
    client: Promise<RunnerClient>,
    private readonly spec: SubprocessSpawnSpec,
    private readonly frame: PathFrames,
  ) {
    // A child that asks for the extra channel is dsh's PTC runtime today: the
    // PTC feature owns the caller's end and the call that reaches it.
    this.ptc = spec.stdio.control === "pipe" ? new PtcPipe() : undefined;
    this.control = this.ptc?.channel;
    this.stdin =
      spec.stdio.stdin === "pipe" ? new UnsupportedStdin() : undefined;
    this.stdoutPipe =
      spec.stdio.stdout === "pipe" ? new PassThrough() : undefined;
    this.stderrPipe =
      spec.stdio.stderr === "pipe" ? new PassThrough() : undefined;
    this.stdoutCollection =
      typeof spec.stdio.stdout === "object"
        ? new CollectedBuffer(spec.stdio.stdout.maxBytes)
        : undefined;
    this.stderrCollection =
      typeof spec.stdio.stderr === "object"
        ? new CollectedBuffer(spec.stdio.stderr.maxBytes)
        : undefined;
    if (spec.signal !== undefined) {
      if (spec.signal.aborted) {
        this.controller.abort(spec.signal.reason);
      } else {
        spec.signal.addEventListener(
          "abort",
          () => this.controller.abort(spec.signal!.reason),
          { once: true },
        );
      }
    }
    this.done = this.run(client).finally(() => this.ptc?.finish());
  }

  get pid(): number {
    return this.processId;
  }

  get stdout(): Readable | undefined {
    return this.stdoutPipe;
  }

  get stderr(): Readable | undefined {
    return this.stderrPipe;
  }

  get collected() {
    return {
      ...(this.stdoutCollection === undefined
        ? {}
        : { stdout: this.stdoutCollection }),
      ...(this.stderrCollection === undefined
        ? {}
        : { stderr: this.stderrCollection }),
    };
  }

  terminate(): void {
    this.controller.abort(new Error("process terminated"));
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (signal === undefined) {
      await this.done.catch(() => {});
      return true;
    }
    if (signal.aborted) {
      return false;
    }
    return Promise.race([
      this.done.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) =>
        signal.addEventListener("abort", () => resolve(false), { once: true }),
      ),
    ]);
  }

  private async run(
    pendingClient: Promise<RunnerClient>,
  ): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
    const client = await pendingClient;
    const environment = Object.fromEntries(
      Object.entries(this.spec.env ?? {}).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const stdin =
      typeof this.spec.stdio.stdin === "object"
        ? new TextEncoder().encode(this.spec.stdio.stdin.data)
        : new Uint8Array();
    const argv = await this.canonicalExecutable(
      this.translatedArgv(),
      client,
      environment,
    );
    const request: Omit<ExecRequest, "$typeName"> = {
      argv,
      cwd: this.translatedWorkdir(),
      env: environment,
      stdin,
    };
    try {
      // A PTC run keeps its request half open for channel bytes; a plain command
      // sends its one request message and ends the stream. Starting one can fail
      // — a bootstrap that cannot be placed, a channel the caller closed — and
      // the pipes close either way.
      const stream =
        this.ptc === undefined
          ? client.exec(request, { signal: this.controller.signal })
          : await this.ptc.start(client, request, this.controller.signal);
      for await (const response of stream) {
        if (response.event.case === "started") {
          this.processId = Number(response.event.value.pid);
        } else if (response.event.case === "stdout") {
          this.writeOutput("stdout", response.event.value);
        } else if (response.event.case === "stderr") {
          this.writeOutput("stderr", response.event.value);
        } else if (response.event.case === "control") {
          this.ptc?.deliver(response.event.value);
        } else if (response.event.case === "exited") {
          return {
            exitCode:
              response.event.value.signal === ""
                ? response.event.value.exitCode
                : null,
            signal:
              response.event.value.signal === ""
                ? null
                : (response.event.value.signal as NodeJS.Signals),
          };
        }
      }
      throw new Error("runner exec stream ended without an exit status");
    } finally {
      this.stdoutPipe?.end();
      this.stderrPipe?.end();
    }
  }

  /**
   * The spawn's workdir in sandbox coordinates. Callers that already speak
   * sandbox coordinates are unchanged; a session-frame cwd — the stock tool
   * rows pass `session.header.cwd` — maps onto the sandbox workspace, where
   * this process actually runs.
   */
  private translatedWorkdir(): string {
    return pathInSandbox(
      this.spec.cwd,
      this.frame.sessionWorkspace,
      this.frame.sandboxWorkspace,
    );
  }

  /**
   * The spawn's argv in sandbox coordinates. Every element that is an absolute
   * path inside the session workspace maps onto the sandbox workspace; the
   * stock `tool-fs-search` row passes the model's search root that way. The
   * mapping is exact rather than a guess: a path under the session workspace
   * can only name that workspace, so nothing else can match. Relative values,
   * flags, and paths already in sandbox coordinates are unchanged.
   */
  private translatedArgv(): string[] {
    return this.spec.argv.map((argument) =>
      pathInSandbox(
        argument,
        this.frame.sessionWorkspace,
        this.frame.sandboxWorkspace,
      ),
    );
  }

  /**
   * Map argv[0] onto the sandbox execution world when it names a host path.
   * An absolute path outside the sandbox workspace cannot exist there — a
   * packaged host binary such as `@vscode/ripgrep`'s ripgrep has no counterpart
   * at the same path — so resolve it against the sandbox's own lookup: first
   * the literal path (callers already speaking sandbox coordinates hit this),
   * then the basename, which resolves to the sandbox's own build of the same
   * tool. When neither resolves, keep the original so the runner reports the
   * failure it always did.
   */
  private async canonicalExecutable(
    argv: readonly string[],
    client: RunnerClient,
    environment: Record<string, string>,
  ): Promise<string[]> {
    const [executable] = argv;
    if (
      executable === undefined ||
      !isAbsolute(executable) ||
      isInsideSandboxWorkspace(executable, this.frame.sandboxWorkspace)
    ) {
      return [...argv];
    }
    for (const candidate of [executable, basename(executable)]) {
      try {
        const resolved = await client.resolveExecutable({
          command: candidate,
          env: { ...environment },
        });
        return [resolved.path, ...argv.slice(1)];
      } catch {
        // Try the next candidate; falling through keeps the original argv[0].
      }
    }
    return [...argv];
  }

  private writeOutput(stream: "stdout" | "stderr", chunk: Uint8Array): void {
    const mode = this.spec.stdio[stream];
    if (mode === "inherit") {
      (stream === "stdout" ? process.stdout : process.stderr).write(chunk);
    } else if (mode === "pipe") {
      (stream === "stdout" ? this.stdoutPipe : this.stderrPipe)?.write(chunk);
    } else {
      (stream === "stdout"
        ? this.stdoutCollection
        : this.stderrCollection
      )?.append(chunk);
    }
  }
}

class UnsupportedStdin extends Writable {
  override _write(
    _chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback(
      new Error("streaming stdin requires the deferred interactive transport"),
    );
  }
}

class CollectedBuffer implements SubprocessOutputReader {
  private tail = new Uint8Array();
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Uint8Array): void {
    const joined = new Uint8Array(this.tail.byteLength + chunk.byteLength);
    joined.set(this.tail);
    joined.set(chunk, this.tail.byteLength);
    this.totalBytes += chunk.byteLength;
    this.tail = joined.subarray(Math.max(0, joined.byteLength - this.maxBytes));
  }

  readFrom(fromByte: number) {
    const tailStart = this.totalBytes - this.tail.byteLength;
    const lossy = fromByte < tailStart;
    const offset = lossy ? 0 : Math.max(0, fromByte - tailStart);
    return {
      text: new TextDecoder().decode(this.tail.subarray(offset)),
      nextOffset: this.totalBytes,
      lossy,
    };
  }
}

export const testing = { CollectedBuffer };
export default SandboxSubprocessRuntime;
