/**
 * The control plane's half of the sandbox terminal feature: one session over
 * the runner's bidirectional terminal RPC, and the pool that owns the sessions
 * this runtime has open.
 *
 * Everything the feature needs on this side lives in this folder.
 * `subprocess.ts` only hands a spawn request to {@link TerminalPool.spawn}.
 *
 * @module @zhming0/dsh-yawn/terminal/remote-terminal
 */

import { PassThrough, type Readable } from "node:stream";

import type { Client } from "@connectrpc/connect";
import type {
  SubprocessOutcome,
  SubprocessTerminalActivity,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";

import {
  TerminalActivityState,
  TerminalQueryKind,
  TerminalService,
} from "../gen/dsh/yawn/v1/terminal_pb.js";
import { MessageQueue } from "../message-queue.js";
import type { RunnerClient } from "../runner-client.js";
import { pathInSandbox, type PathFrames } from "../sandbox-path.js";

type TerminalClient = Client<typeof TerminalService>;

/** One request message of the terminal stream, as the client accepts it. */
type TerminalRequestMessage =
  Parameters<TerminalClient["terminal"]>[0] extends AsyncIterable<infer M>
    ? M
    : never;

/** One response of the terminal stream, as the client decodes it. */
type TerminalResponseMessage =
  ReturnType<TerminalClient["terminal"]> extends AsyncIterable<infer M>
    ? M
    : never;

/**
 * Every terminal the subprocess seam has open. A terminal lives and dies with
 * its sandbox, so the seam terminates them all when it is disposed.
 */
export class TerminalPool {
  private readonly live = new Set<RemoteTerminal>();

  /**
   * Allocate one terminal and wait for the runner to report its pid. The
   * spec's signal cancels allocation only; it is detached once the handle is
   * published, because later keystrokes must not need an agent boundary.
   */
  async spawn(
    client: Promise<RunnerClient>,
    spec: SubprocessTerminalSpawnSpec,
    frame: PathFrames,
  ): Promise<SubprocessTerminalHandle> {
    const allocation = new AbortController();
    const cancelAllocation = (): void => allocation.abort(spec.signal?.reason);
    if (spec.signal !== undefined) {
      if (spec.signal.aborted) {
        cancelAllocation();
      } else {
        spec.signal.addEventListener("abort", cancelAllocation, { once: true });
      }
    }
    const terminal = new RemoteTerminal(
      await client,
      spec,
      frame,
      allocation.signal,
    );
    this.live.add(terminal);
    void terminal.done
      .catch(() => {})
      .finally(() => this.live.delete(terminal));
    try {
      await terminal.start();
    } catch (error) {
      spec.signal?.removeEventListener("abort", cancelAllocation);
      await terminal.terminate().catch(() => {});
      throw error;
    }
    spec.signal?.removeEventListener("abort", cancelAllocation);
    return terminal;
  }

  async terminateAll(): Promise<void> {
    await Promise.allSettled(
      [...this.live].map((terminal) => terminal.terminate()),
    );
  }
}

/**
 * One terminal session in the sandbox, over the runner's bidirectional
 * terminal RPC. Output and exit facts stream in; input, resize, foreground and
 * activity queries, and signals stream out. Sending a control is serialized,
 * so the runner answers are matched to their controls in order.
 */
class RemoteTerminal implements SubprocessTerminalHandle {
  private readonly outputPipe = new PassThrough();
  private readonly requests = new MessageQueue<TerminalRequestMessage>();
  private readonly replies: PendingReply[] = [];
  private readonly started = new Deferred<number>();
  private readonly completion = new Deferred<SubprocessOutcome>();
  /** Resolves when the response stream ends, after every output write. */
  private readonly finished = new Deferred<void>();
  /** Serializes control sends; query and signal replies arrive in this order. */
  private control: Promise<unknown> = Promise.resolve();
  private closed = false;
  /** True once the runner reported the terminal quiescent (a `closed` event). */
  private quiescent = false;
  private pidValue = -1;
  private activityKey = "";
  private activityRevision = 0;

  constructor(
    client: RunnerClient,
    private readonly spec: SubprocessTerminalSpawnSpec,
    private readonly frame: PathFrames,
    allocation: AbortSignal,
  ) {
    // A terminal that fails before its owner subscribes still has to reject
    // for that owner without surfacing as an unhandled rejection, and an
    // unread output stream must not turn that failure into an uncaught
    // stream error.
    void this.completion.promise.catch(() => {});
    this.outputPipe.on("error", () => {});
    this.requests.push({
      control: {
        case: "start",
        value: {
          argv: spec.argv.map((argument) =>
            pathInSandbox(
              argument,
              frame.sessionWorkspace,
              frame.sandboxWorkspace,
            ),
          ),
          cwd: pathInSandbox(
            spec.cwd,
            frame.sessionWorkspace,
            frame.sandboxWorkspace,
          ),
          env: Object.fromEntries(
            Object.entries(spec.env ?? {}).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          rows: spec.rows,
          cols: spec.cols,
          terminalType: spec.terminalType,
          graceMs: spec.graceMs,
        },
      },
    });
    void this.consume(client, allocation);
  }

  get pid(): number {
    return this.pidValue;
  }

  get output(): Readable {
    return this.outputPipe;
  }

  get done(): Promise<SubprocessOutcome> {
    return this.completion.promise;
  }

  /** Wait until the runner reports the allocated terminal's pid. */
  async start(): Promise<void> {
    this.pidValue = await this.started.promise;
  }

  async write(data: string): Promise<void> {
    const bytes = new TextEncoder().encode(data);
    await this.serialized(() => {
      this.requests.push({ control: { case: "input", value: bytes } });
    });
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (
      !Number.isInteger(cols) ||
      cols < 1 ||
      !Number.isInteger(rows) ||
      rows < 1
    ) {
      throw new Error("terminal cols and rows must be positive integers");
    }
    await this.serialized(() => {
      this.requests.push({
        control: { case: "resize", value: { cols, rows } },
      });
    });
  }

  async inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    // A terminal the runner reported quiescent has no live process to hold a
    // foreground group, and its control stream is closed.
    if (this.quiescent) {
      return undefined;
    }
    const response = await this.query(TerminalQueryKind.FOREGROUND);
    const foreground = response.event.value as {
      present: boolean;
      processGroupId: number;
      inputWaiting: boolean;
    };
    if (!foreground.present) {
      return undefined;
    }
    return {
      processGroupId: foreground.processGroupId,
      inputWaiting: foreground.inputWaiting,
    };
  }

  async inspectActivity(): Promise<SubprocessTerminalActivity> {
    // A terminal the runner reported quiescent owns nothing: the shell was
    // reaped and no process holds the PTY. Answering idle lets the caller
    // reclaim what it retained instead of polling a closed stream forever.
    if (this.quiescent) {
      return this.observeActivity("idle");
    }
    const response = await this.query(TerminalQueryKind.ACTIVITY);
    const state = (response.event.value as { state: TerminalActivityState })
      .state;
    return this.observeActivity(
      state === TerminalActivityState.IDLE
        ? "idle"
        : state === TerminalActivityState.BUSY
          ? "busy"
          : "unknown",
    );
  }

  private observeActivity(
    state: SubprocessTerminalActivity["state"],
  ): SubprocessTerminalActivity {
    if (state !== this.activityKey) {
      this.activityKey = state;
      this.activityRevision += 1;
    }
    return { state, revision: this.activityRevision };
  }

  async signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    const response = await this.reply((send) => {
      send({ control: { case: "signal", value: signal } });
    });
    const pgid = response.event.value as number;
    if (pgid === 0) {
      throw new Error(
        `no foreground process group accepted ${signal} in terminal ${this.pidValue}`,
      );
    }
    return pgid;
  }

  async terminate(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      // The runner terminates the session when the client half ends; a
      // transport already gone has nothing left to end.
      this.requests.end();
    }
    await this.finished.promise;
  }

  /** Send one control that expects exactly one reply, in send order. */
  private query(kind: TerminalQueryKind): Promise<TerminalResponseMessage> {
    return this.reply((send) => {
      send({ control: { case: "query", value: { kind } } });
    });
  }

  private reply(
    send: (dispatch: (message: TerminalRequestMessage) => void) => void,
  ): Promise<TerminalResponseMessage> {
    return this.serialized(
      () =>
        new Promise<TerminalResponseMessage>((resolve, reject) => {
          this.replies.push({ resolve, reject });
          try {
            send((message) => this.requests.push(message));
          } catch (error) {
            this.replies.pop();
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }),
    );
  }

  /**
   * Run one control send after every earlier one. A rejected operation does
   * not break the chain: the next control still sees a settled predecessor.
   */
  private serialized<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    const pending = this.control.then(() => {
      if (this.closed) {
        throw new Error("terminal is closed");
      }
      return operation();
    });
    this.control = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async consume(
    client: RunnerClient,
    allocation: AbortSignal,
  ): Promise<void> {
    try {
      for await (const response of client.terminals.terminal(this.requests, {
        signal: allocation,
      })) {
        switch (response.event.case) {
          case "started":
            this.pidValue = Number(response.event.value.pid);
            this.started.resolve(this.pidValue);
            break;
          case "output":
            this.outputPipe.write(response.event.value);
            break;
          case "exited": {
            const exit = response.event.value;
            this.completion.resolve({
              exitCode: exit.signal === "" ? exit.exitCode : null,
              signal:
                exit.signal === "" ? null : (exit.signal as NodeJS.Signals),
            });
            break;
          }
          case "closed":
            // The terminal is quiescent: output is complete, and ending the
            // request half lets the runner finish without resetting a stream
            // whose request body is still open.
            this.outputPipe.end();
            this.quiescent = true;
            this.closed = true;
            this.requests.end();
            this.finish();
            break;
          case "foreground":
          case "activity":
          case "signaled":
            this.replies.shift()?.resolve(response);
            break;
          default:
            break;
        }
      }
      // The runner ends the stream once the session is quiescent, so a stream
      // that closes without an exit status is a lost terminal, not a clean
      // one.
      if (this.completion.settled) {
        this.outputPipe.end();
        this.finish();
      } else {
        this.fail(new Error("terminal stream ended without an exit status"));
      }
    } catch (error) {
      this.fail(error);
    }
  }

  /** Settle everything a lost terminal can no longer answer. */
  private fail(error: unknown): void {
    this.closed = true;
    this.requests.end();
    if (!this.started.settled) {
      this.started.reject(error);
    }
    if (!this.completion.settled) {
      this.completion.reject(error);
    }
    for (const reply of this.replies.splice(0)) {
      reply.reject(error);
    }
    this.outputPipe.destroy(
      error instanceof Error ? error : new Error(String(error)),
    );
    this.finish();
  }

  private finish(): void {
    if (!this.finished.settled) {
      this.finished.resolve();
    }
  }
}

interface PendingReply {
  resolve: (response: TerminalResponseMessage) => void;
  reject: (error: unknown) => void;
}

/** A promise with a settled flag, for streams that may end before or after. */
class Deferred<T> {
  private readonly promiseValue: Promise<T>;
  private resolveValue!: (value: T) => void;
  private rejectValue!: (error: unknown) => void;
  private done = false;

  constructor() {
    this.promiseValue = new Promise<T>((resolve, reject) => {
      this.resolveValue = resolve;
      this.rejectValue = reject;
    });
  }

  get promise(): Promise<T> {
    return this.promiseValue;
  }

  get settled(): boolean {
    return this.done;
  }

  resolve(value: T): void {
    if (!this.done) {
      this.done = true;
      this.resolveValue(value);
    }
  }

  reject(error: unknown): void {
    if (!this.done) {
      this.done = true;
      this.rejectValue(error);
    }
  }
}
