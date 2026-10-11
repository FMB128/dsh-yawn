import type { Duplex } from "node:stream";

import { createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";

import { PtcService } from "./gen/dsh/yawn/v1/ptc_pb.js";
import { TerminalService } from "./gen/dsh/yawn/v1/terminal_pb.js";
import {
  RunnerService,
  type EditFileRequest,
  type ExecRequest,
  type GitCredential,
  type ReadFileRangeRequest,
  type ReadFileRequest,
  type ResolveExecutableRequest,
  type ResolvePathRequest,
  type SetupRequest,
  type StatRequest,
  type TreeRequest,
  type WriteFileRequest,
} from "./gen/dsh/yawn/v1/runner_pb.js";

type GeneratedClient = Client<typeof RunnerService>;
type PtcClient = Client<typeof PtcService>;
type CallOptions = { signal?: AbortSignal; timeoutMs?: number };

/** One message of a proxied request stream, in the shape the client accepts. */
export type HttpProxyRequestMessage =
  Parameters<GeneratedClient["httpProxy"]>[0] extends AsyncIterable<infer M>
    ? M
    : never;

/** One message of a PTC run's request stream. */
export type PtcRunRequestMessage =
  Parameters<PtcClient["run"]>[0] extends AsyncIterable<infer M> ? M : never;

/** A small facade keeps generated RPC details out of dsh capability adapters. */
export class RunnerClient {
  constructor(
    private readonly client: GeneratedClient,
    /**
     * The terminal service. It shares this connection, and the sandbox
     * terminal feature is its only user (see `proto/dsh/yawn/v1/terminal.proto`).
     */
    readonly terminals: Client<typeof TerminalService>,
    /**
     * PTC mode's service. It shares this connection, and the sandbox PTC
     * feature is its only user (see `proto/dsh/yawn/v1/ptc.proto`).
     */
    readonly ptc: Client<typeof PtcService>,
  ) {}

  health(options?: CallOptions) {
    return this.client.health({}, options);
  }

  sandboxStatus(options?: CallOptions) {
    return this.client.sandboxStatus({}, options);
  }

  exec(request: Omit<ExecRequest, "$typeName">, options?: CallOptions) {
    return this.client.exec(request, options);
  }

  resolveExecutable(
    request: Omit<ResolveExecutableRequest, "$typeName">,
    options?: CallOptions,
  ) {
    return this.client.resolveExecutable(request, options);
  }

  resolvePath(
    request: Omit<ResolvePathRequest, "$typeName">,
    options?: CallOptions,
  ) {
    return this.client.resolvePath(request, options);
  }

  readFile(request: Omit<ReadFileRequest, "$typeName">, options?: CallOptions) {
    return this.client.readFile(request, options);
  }

  readFileRange(
    request: Omit<ReadFileRangeRequest, "$typeName">,
    options?: CallOptions,
  ) {
    return this.client.readFileRange(request, options);
  }

  writeFile(
    request: Omit<WriteFileRequest, "$typeName">,
    options?: CallOptions,
  ) {
    return this.client.writeFile(request, options);
  }

  editFile(request: Omit<EditFileRequest, "$typeName">, options?: CallOptions) {
    return this.client.editFile(request, options);
  }

  stat(request: Omit<StatRequest, "$typeName">, options?: CallOptions) {
    return this.client.stat(request, options);
  }

  list(path: string, options?: CallOptions) {
    return this.client.list({ path }, options);
  }

  tree(request: Omit<TreeRequest, "$typeName">, options?: CallOptions) {
    return this.client.tree(request, options);
  }

  async setSecrets(secrets: Record<string, string>): Promise<void> {
    await this.client.setSecrets({ secrets });
  }

  async setGitCredentials(
    credentials: Omit<GitCredential, "$typeName">[],
  ): Promise<void> {
    await this.client.setGitCredentials({ credentials });
  }

  setup(request: Omit<SetupRequest, "$typeName">) {
    return this.client.setup(request);
  }

  /**
   * Relay one browser request to the sandbox's loopback. The request iterable
   * yields the head message and then body chunks; the response iterable yields
   * the response head and then body chunks.
   */
  httpProxy(
    request: AsyncIterable<HttpProxyRequestMessage>,
    options?: CallOptions,
  ) {
    return this.client.httpProxy(request, options);
  }
}

/**
 * Build a client speaking plain HTTP/2 over one runner-initiated tunnel
 * socket. The socket carries exactly one HTTP/2 session: when it closes, the
 * client is dead and the runner must register again.
 */
export function runnerClientForSocket(socket: Duplex): RunnerClient {
  let used = false;
  const transport = createConnectTransport({
    // The runner ignores the authority; requests never leave this socket.
    baseUrl: "http://dsh-yawn-runner.invalid",
    httpVersion: "2",
    nodeOptions: {
      createConnection: () => {
        if (used) {
          throw new Error("runner tunnel is closed");
        }
        used = true;
        return socket;
      },
    },
    pingIntervalMs: 30_000,
    pingIdleConnection: true,
    pingTimeoutMs: 10_000,
    // The default closes idle sessions after 15 minutes. This tunnel is
    // one-to-one with a registered runner and pings already detect a dead
    // path, so closing an idle-but-healthy tunnel would only force a
    // pointless re-registration. The cap is setTimeout's maximum delay.
    idleConnectionTimeoutMs: 2 ** 31 - 1,
  });

  return new RunnerClient(
    createClient(RunnerService, transport),
    createClient(TerminalService, transport),
    createClient(PtcService, transport),
  );
}
