import { describe, expect, it } from "vitest";

import type { RunResponse } from "../src/gen/dsh/yawn/v1/ptc_pb.js";
import { PtcPipe } from "../src/ptc/pipe.js";
import type {
  PtcRunRequestMessage,
  RunnerClient,
} from "../src/runner-client.js";

/** What one PTC run asked the runner to do, in order. */
interface RecordedRun {
  messages: PtcRunRequestMessage[];
}

function fakeRunnerClient(run: RecordedRun): RunnerClient {
  return {
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

describe("PTC run", () => {
  it("keeps the start message ahead of writes that came first", async () => {
    const run: RecordedRun = { messages: [] };
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
    const run: RecordedRun = { messages: [] };
    const pipe = new PtcPipe();
    pipe.channel.destroy();

    await expect(
      pipe.start(fakeRunnerClient(run), commandOver(["node"])),
    ).rejects.toThrow("PTC channel closed before the command started");
    expect(run.messages).toEqual([]);
  });
});
