import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";

import { SandboxFileSystem } from "../src/fs.js";

import type { RunResponse } from "../src/gen/dsh/yawn/v1/ptc_pb.js";
import {
  bootstrapPathInSandbox,
  placeBootstrap,
} from "../src/ptc/bootstrap.js";
import { PtcPipe } from "../src/ptc/pipe.js";
import type {
  PtcRunRequestMessage,
  RunnerClient,
} from "../src/runner-client.js";

/** The provider's own install layout, in a temporary directory. */
async function installedBootstrap(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-ptc-"));
  const directory = join(
    root,
    "node_modules",
    "@deepseek-ai",
    "dsh-ptc-runtime-node",
    "lib",
  );
  await mkdir(directory, { recursive: true });
  const path = join(directory, "process.js");
  await writeFile(path, content);
  return path;
}

/** What one PTC run asked the runner to do, in order. */
interface RecordedRun {
  writes: Array<{ path: string; content: Uint8Array }>;
  messages: PtcRunRequestMessage[];
}

function fakeRunnerClient(run: RecordedRun): RunnerClient {
  return {
    writeFile(request: { path: string; content: Uint8Array }) {
      run.writes.push({ path: request.path, content: request.content });
      return Promise.resolve({
        created: true,
        version: "version",
        hadBefore: false,
        before: new Uint8Array(),
      });
    },
    ptc: {
      async *run(request: AsyncIterable<PtcRunRequestMessage>) {
        for await (const message of request) {
          run.messages.push(message);
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

function commandOver(argv: string[]) {
  return {
    argv,
    cwd: "/workspace/repository",
    env: {},
    stdin: new Uint8Array(),
  };
}

async function drain(stream: AsyncIterable<RunResponse>): Promise<string[]> {
  const events: string[] = [];
  for await (const response of stream) {
    events.push(response.event.case ?? "none");
  }
  return events;
}

describe("PTC bootstrap", () => {
  it("maps the provider's bootstrap into the sandbox", async () => {
    const path = await installedBootstrap("bootstrap");
    const sandbox = bootstrapPathInSandbox(path);
    expect(sandbox).toMatch(
      /^\/workspace\/\.dsh-yawn\/ptc-runtime-node\/[0-9a-f]{12}\/process\.js$/,
    );
    // The same install always maps to the same path: the provider resolves it
    // once per request and the command reads that exact file.
    expect(bootstrapPathInSandbox(path)).toBe(sandbox);
  });

  it("maps a path the control plane resolved on Windows", () => {
    expect(
      bootstrapPathInSandbox(
        "C:\\dsh\\node_modules\\@deepseek-ai\\dsh-ptc-runtime-node\\lib\\process.js",
      ),
    ).toMatch(/^\/workspace\/\.dsh-yawn\/ptc-runtime-node\//);
  });

  it("gives two installed copies two sandbox paths", async () => {
    const first = await installedBootstrap("one");
    const second = await installedBootstrap("two");
    expect(bootstrapPathInSandbox(first)).not.toBe(
      bootstrapPathInSandbox(second),
    );
  });

  it("leaves host files it does not own alone", () => {
    // Another package's file, another file of the same package, and a path that
    // merely ends with the same basename.
    expect(bootstrapPathInSandbox("/tmp/elsewhere/process.js")).toBeUndefined();
    expect(
      bootstrapPathInSandbox(
        "/dsh/node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/other.js",
      ),
    ).toBeUndefined();
    expect(
      bootstrapPathInSandbox("/tmp/dsh-ptc-runtime-node/lib/process.js"),
    ).toBeUndefined();
  });

  it("copies the mapped file into the sandbox, byte for byte", async () => {
    const source = await installedBootstrap("export const bootstrap = 1;\n");
    const sandbox = bootstrapPathInSandbox(source)!;
    const run: RecordedRun = { writes: [], messages: [] };

    await placeBootstrap(fakeRunnerClient(run), sandbox);

    expect(run.writes).toHaveLength(1);
    expect(run.writes[0]?.path).toBe(sandbox);
    expect(Buffer.from(run.writes[0]!.content).toString()).toBe(
      "export const bootstrap = 1;\n",
    );
  });

  it("writes nothing for a path it never mapped", async () => {
    const run: RecordedRun = { writes: [], messages: [] };
    await placeBootstrap(
      fakeRunnerClient(run),
      "/workspace/repository/main.ts",
    );
    expect(run.writes).toEqual([]);
  });
});

describe("PTC run", () => {
  it("places the program's bootstrap before starting it", async () => {
    const source = await installedBootstrap("bootstrap bytes");
    const sandbox = bootstrapPathInSandbox(source)!;
    const run: RecordedRun = { writes: [], messages: [] };
    const pipe = new PtcPipe();

    const stream = await pipe.start(
      fakeRunnerClient(run),
      commandOver(["node", sandbox, "67108864"]),
    );
    pipe.channel.destroy();
    expect(await drain(stream)).toEqual(["started", "exited"]);

    expect(run.writes.map((write) => write.path)).toEqual([sandbox]);
    expect(run.messages.map((message) => message.message?.case)).toEqual([
      "start",
    ]);
  });

  it("keeps the start message ahead of writes that came first", async () => {
    const run: RecordedRun = { writes: [], messages: [] };
    const pipe = new PtcPipe();
    pipe.channel.write(Buffer.from("early"));

    const stream = await pipe.start(
      fakeRunnerClient(run),
      commandOver(["node"]),
    );
    pipe.channel.destroy();

    expect(await drain(stream)).toEqual(["started", "control", "exited"]);
    expect(run.messages.map((message) => message.message?.case)).toEqual([
      "start",
      "control",
    ]);
    expect(run.messages[1]?.message?.value).toEqual(
      new Uint8Array([101, 97, 114, 108, 121]),
    );
  });

  it("refuses to start a run whose caller closed the channel", async () => {
    const run: RecordedRun = { writes: [], messages: [] };
    const pipe = new PtcPipe();
    pipe.channel.destroy();

    await expect(
      pipe.start(fakeRunnerClient(run), commandOver(["node"])),
    ).rejects.toThrow("PTC channel closed before the command started");
    expect(run.messages).toEqual([]);
  });
});

describe("PTC bootstrap through the filesystem service", () => {
  it("answers the provider's own path and leaves other host files alone", async () => {
    const ctx = new Context();
    ctx.provide("sandboxManager", {
      workspace: "/workspace",
      clientForCurrentAgent: async () => ({}),
      rootSessionIdForCurrentAgent: () => "session-one",
    });
    ctx.provide("agents", { requireInitiator: () => ({ id: "session-one" }) });
    const fs = new SandboxFileSystem(ctx);

    // This is how the provider asks where its bootstrap lives in the sandbox.
    const source = await installedBootstrap("bootstrap");
    expect(fs.processPathFromHostPath(source)).toBe(
      bootstrapPathInSandbox(source),
    );
    expect(
      fs.processPathFromHostPath("/tmp/some-other-file.md"),
    ).toBeUndefined();
  });
});
