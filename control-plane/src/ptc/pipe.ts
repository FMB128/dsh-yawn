/**
 * The control plane's half of a PTC run: the byte channel to the program the
 * model wrote, and the runner call that carries it.
 *
 * Everything the feature needs on this side lives in this folder, and
 * `subprocess.ts` hands it the spawn: the bytes are the program's own protocol,
 * and nothing here allocates a PTY.
 *
 * @module @zhming0/dsh-yawn/ptc/pipe
 */

import { Duplex } from "node:stream";

import type { RunResponse, RunStart } from "../gen/dsh/yawn/v1/ptc_pb.js";
import { MessageQueue } from "../message-queue.js";
import type { PtcRunRequestMessage, RunnerClient } from "../runner-client.js";

/** The start message, in the shape the generated client accepts. */
export type PtcCommand = Omit<RunStart, "$typeName">;

/**
 * One PTC run, over the runner's PtcService. The subprocess interface asks for
 * it when a spawn requests `stdio.control: 'pipe'`, and it starts once the
 * command's coordinates are resolved.
 */
export class PtcPipe {
  /**
   * The caller's end of the pipe. A Duplex because dsh hands consumers one raw
   * byte channel in both directions; framing, validation and backpressure stay
   * with them.
   */
  readonly channel = new PtcChannel();

  /**
   * Start the run. A channel the caller closed before this point cannot start
   * one, and the spawn fails instead of running something unreachable.
   */
  async start(
    client: RunnerClient,
    command: PtcCommand,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<RunResponse>> {
    const requests = this.channel.begin(command);
    if (requests === undefined) {
      throw new Error("PTC channel closed before the command started");
    }
    return client.ptc.run(requests, signal === undefined ? {} : { signal });
  }

  /** Hand the program's bytes to the caller's reader. */
  deliver(bytes: Uint8Array): void {
    this.channel.deliver(bytes);
  }

  /** The run is over: end the request half and the caller's reads. */
  finish(): void {
    this.channel.finish();
  }
}

/**
 * The caller's end of one PTC run's channel. Writes become request messages
 * after the start message; bytes the program writes to its fd 7 are pushed back
 * as they arrive.
 */
class PtcChannel extends Duplex {
  private readonly requests = new MessageQueue<PtcRunRequestMessage>();
  /**
   * Writes that arrived before the start message. A consumer may write to the
   * channel the moment spawn returns, while the start message's argv is still
   * being resolved; the start message must be first on the stream regardless.
   */
  private readonly earlyWrites: Uint8Array[] = [];
  private started = false;

  constructor() {
    // The command's end closing is not the caller's end closing: the readable
    // side ends when the exec stream is over, and a caller that has stopped
    // reading must not make the process look finished.
    super({ allowHalfOpen: true });
  }

  override _read(): void {
    // Bytes are pushed as the RPC delivers them.
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.started) {
      this.earlyWrites.push(new Uint8Array(chunk));
      callback();
      return;
    }
    try {
      this.requests.push({
        message: { case: "control", value: new Uint8Array(chunk) },
      });
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    // A caller that ends its endpoint instead of destroying it half-closes the
    // channel the same way: the program reads end-of-file, and its output and
    // exit status still arrive.
    this.requests.end();
    callback();
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    // Closing the caller's endpoint ends the request half, which the runner
    // turns into end-of-file on the program's fd 7.
    this.requests.end();
    callback(error);
  }

  /**
   * Queue the start message, then every write that preceded it, and answer the
   * request stream. Undefined once the channel is closed.
   */
  begin(command: PtcCommand): AsyncIterable<PtcRunRequestMessage> | undefined {
    try {
      this.requests.push({ message: { case: "start", value: command } });
      this.started = true;
      for (const bytes of this.earlyWrites.splice(0)) {
        this.requests.push({ message: { case: "control", value: bytes } });
      }
      return this.requests;
    } catch {
      return undefined;
    }
  }

  /** Hand the program's bytes to the caller's reader. */
  deliver(bytes: Uint8Array): void {
    if (!this.destroyed) {
      this.push(bytes);
    }
  }

  /** The run is over: end the request half and the caller's reads. */
  finish(): void {
    this.requests.end();
    if (!this.destroyed) {
      this.push(null);
    }
  }
}
