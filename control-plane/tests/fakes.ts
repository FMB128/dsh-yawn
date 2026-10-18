import { FileType } from "../src/gen/dsh/yawn/v1/runner_pb.js";
import type { RunnerClient } from "../src/runner-client.js";
import type { RunnerGateway } from "../src/tunnel.js";
import type {
  BackendReference,
  SandboxBackend,
  SandboxSpec,
} from "../src/types.js";

/** Test doubles shared by the SandboxManager suites. */
export class FakeWorkspaceRegistry {
  readonly creates: Array<{ path: string; title?: string }> = [];
  readonly archivedSessionIds: string[] = [];

  async create(path: string, title?: string) {
    this.creates.push(title === undefined ? { path } : { path, title });
    return { path };
  }

  list() {
    return this.creates.map(({ path, title }) => ({
      path,
      title: title ?? path,
    }));
  }
}

export interface FakeExec {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: Uint8Array;
}

export class FakeRunnerClient {
  setups = 0;
  healthy = true;
  secrets: Record<string, string> = {};
  readonly treeRequests: unknown[] = [];
  /** Every exec request, in order. */
  readonly execs: FakeExec[] = [];
  /** Replies for exec calls, consumed in order; the default succeeds silently. */
  readonly execReplies: Array<{
    stdout?: string | Uint8Array;
    exitCode?: number;
  }> = [];
  readonly setupRequests: Array<{ revision: string }> = [];
  /** The clone URL of each setup call, in order. */
  readonly setupRepositoryUrls: string[] = [];

  async health() {
    if (!this.healthy) {
      throw new Error("runner is unavailable");
    }
    return { sandboxId: "sandbox-one", setupComplete: this.setups > 0 };
  }

  /** What the machine reports for the Sandbox tab. */
  async sandboxStatus() {
    return {
      sandboxId: "sandbox-one",
      hostname: "sandbox-one-host",
      osName: "Debian GNU/Linux 13 (trixie)",
      kernelVersion: "6.8.0",
      architecture: "amd64",
      cpuCount: 4,
      memoryTotalBytes: 2n * 1024n ** 3n,
      workspaceDiskUsedBytes: 1024n ** 3n,
      workspaceDiskTotalBytes: 8n * 1024n ** 3n,
      filesystemDiskUsedBytes: 3n * 1024n ** 3n,
      filesystemDiskTotalBytes: 16n * 1024n ** 3n,
      uptimeSeconds: 90n,
      listeningPorts: [3000, 5173],
    };
  }

  async setSecrets(secrets: Record<string, string>) {
    this.secrets = secrets;
  }
  /** Every credential push, in order, as the control plane resolved them. */
  readonly gitCredentials: Array<{
    host: string;
    username: string;
    password: string;
  }> = [];
  async setGitCredentials(
    credentials: {
      host: string;
      username: string;
      password: string;
    }[],
  ) {
    this.gitCredentials.push(...credentials);
  }

  async setup(request: { repositoryUrl: string; revision: string }) {
    this.setups += 1;
    this.setupRepositoryUrls.push(request.repositoryUrl);
    this.setupRequests.push({ revision: request.revision });
    return { ran: this.setups === 1 };
  }

  async tree(request: unknown) {
    this.treeRequests.push(request);
    return {
      entries: [
        { relativePath: "src", type: FileType.DIRECTORY },
        { relativePath: "src/index.ts", type: FileType.REGULAR },
        { relativePath: "link", type: FileType.UNSPECIFIED },
      ],
      truncated: false,
    };
  }

  async *exec(request: FakeExec) {
    this.execs.push(request);
    const reply = this.execReplies.shift() ?? {};
    yield { event: { case: "started" as const, value: { pid: 1n } } };
    if (reply.stdout !== undefined) {
      yield {
        event: {
          case: "stdout" as const,
          value:
            typeof reply.stdout === "string"
              ? new TextEncoder().encode(reply.stdout)
              : reply.stdout,
        },
      };
    }
    yield {
      event: {
        case: "exited" as const,
        value: { exitCode: reply.exitCode ?? 0, signal: "" },
      },
    };
  }
}

export class FakeBackend implements SandboxBackend {
  readonly name = "fake";
  readonly capabilities = {
    supportsHibernate: true,
    wakeKeepsFilesystem: true,
  };
  readonly client = new FakeRunnerClient();
  provisions = 0;
  hibernations = 0;
  wakes = 0;
  destroys = 0;
  expiries = 0;
  running = false;
  /** Thrown by the next destroy, then cleared. */
  destroyFailure: Error | undefined;
  readonly repositoryUrls: string[] = [];
  /** How many times the manager started this backend's early work. */
  preparations = 0;

  async provision(spec: SandboxSpec) {
    this.provisions += 1;
    this.repositoryUrls.push(spec.repositoryUrl);
    this.running = true;
    return { sandboxId: "sandbox-one", reference: { id: "one" } };
  }

  async prepare() {
    this.preparations += 1;
  }

  async hibernate() {
    this.hibernations += 1;
    this.running = false;
  }

  async wake(reference: BackendReference) {
    this.wakes += 1;
    this.running = true;
    this.client.healthy = true;
    return { sandboxId: "sandbox-one", reference };
  }

  async destroy() {
    this.destroys += 1;
    if (this.destroyFailure !== undefined) {
      const failure = this.destroyFailure;
      this.destroyFailure = undefined;
      throw failure;
    }
    this.running = false;
  }

  async expireAt() {
    this.expiries += 1;
  }

  async health() {
    return this.running;
  }
}

/** Stands in for the tunnel: every wait resolves to the fake runner. */
export function gatewayFor(backend: FakeBackend): RunnerGateway {
  return {
    waitFor: async () => backend.client as unknown as RunnerClient,
    drop() {},
  };
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
