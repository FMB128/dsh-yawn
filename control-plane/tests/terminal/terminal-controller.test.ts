import { AsyncLocalStorage } from "node:async_hooks";

import type { Agent } from "@deepseek-ai/dsh-agent";
import type {
  TerminalController,
  TerminalCreateRequest,
  TerminalFrame,
  WebTerminalId,
} from "@deepseek-ai/dsh-api-terminal-controller";
import { describe, expect, it } from "vitest";

import { scopeToSession } from "../../src/terminal/terminal-controller.js";

const AGENT = { id: "session-one" } as unknown as Agent;

/** Stock method names the wrapper replaces. */
const WRAPPED = ["shells", "create", "attach"] as const;

/**
 * Enough of the stock controller to prove the wrapper's effect: `shells` and
 * `create` read the initiator (as every subprocess call does), and `attach`
 * answers the input it was sent with the frames the stock stream would.
 */
class FakeTerminalController {
  readonly initiators: Agent[] = [];
  readonly calls: string[] = [];

  constructor(private readonly agents: { requireInitiator: () => Agent }) {}

  async shells(_agent: Agent, _signal: AbortSignal): Promise<unknown[]> {
    this.initiators.push(this.agents.requireInitiator());
    return [];
  }

  async create(
    _agent: Agent,
    _request: TerminalCreateRequest,
    _signal: AbortSignal,
  ): Promise<unknown> {
    this.initiators.push(this.agents.requireInitiator());
    return { id: "terminal-one" };
  }

  /** The frames one attachment yields: a screen, output, and three acks. */
  attach(
    _agent: Agent,
    _id: WebTerminalId,
    _signal: AbortSignal,
  ): AsyncIterable<TerminalFrame> {
    this.calls.push("attach");
    const frames = [
      { type: "snapshot", sequence: 0, screen: "$ ", writable: true },
      { type: "ack", sequence: 1 },
      { type: "output", sequence: 1, data: "ls\r\n" },
      { type: "ack", sequence: 2 },
      { type: "ack", sequence: 3, refusal: "read-only" },
    ] as TerminalFrame[];
    return (async function* () {
      yield* frames;
    })();
  }

  environment(_agent: Agent, _signal: AbortSignal): unknown {
    return { cwd: "/workspace/repository" };
  }

  list(_sessionId: unknown): unknown[] {
    return [];
  }

  retain(
    _sessionId: unknown,
    _id: unknown,
    _signal: AbortSignal,
  ): AsyncIterable<unknown> {
    return (async function* () {})();
  }

  rename(_agent: Agent, _id: unknown, _title: string): void {}

  close(_agent: Agent, _id: unknown): Promise<void> {
    return Promise.resolve();
  }
}

function makeService() {
  const storage = new AsyncLocalStorage<Agent>();
  const agents = {
    requireInitiator: (): Agent => {
      const current = storage.getStore();
      if (current === undefined) {
        throw new Error("no initiating Agent");
      }
      return current;
    },
    withInitiator: <T>(initiator: Agent, operation: () => T): T =>
      storage.run(initiator, operation),
  };
  const controller = new FakeTerminalController(agents);
  const activity: Agent[] = [];
  const undo = scopeToSession(
    controller as unknown as TerminalController,
    agents,
    (agent) => activity.push(agent),
  );
  return { controller, undo, activity };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("scopeToSession for the terminal controller", () => {
  it("discovers shells and creates terminals as the session agent", async () => {
    const { controller, undo } = makeService();
    const typed = controller as unknown as TerminalController;

    await expect(typed.shells(AGENT, signal())).resolves.toEqual([]);
    await expect(
      typed.create(
        AGENT,
        { id: "terminal-one", cols: 80, rows: 24 } as TerminalCreateRequest,
        signal(),
      ),
    ).resolves.toEqual({ id: "terminal-one" });

    expect(controller.initiators).toEqual([AGENT, AGENT]);

    undo();
    // Stock behaviour again: without an agent boundary the seam refuses.
    await expect(typed.shells(AGENT, signal())).rejects.toThrow(
      "no initiating Agent",
    );
  });

  it("notes accepted terminal input and resize as session activity", async () => {
    const { controller, activity } = makeService();
    const typed = controller as unknown as TerminalController;

    const frames: TerminalFrame[] = [];
    for await (const frame of typed.attach(
      AGENT,
      "terminal-one" as WebTerminalId,
      signal(),
    )) {
      frames.push(frame);
    }

    // Every frame passes through; only the two accepted acks count.
    expect(frames.map((frame) => frame.type)).toEqual([
      "snapshot",
      "ack",
      "output",
      "ack",
      "ack",
    ]);
    expect(controller.calls).toEqual(["attach"]);
    expect(activity).toEqual([AGENT, AGENT]);
  });

  it("leaves the stock prototype and its remote markers alone, and undoes cleanly", () => {
    const { controller, undo } = makeService();
    const typed = controller as unknown as TerminalController;

    for (const method of WRAPPED) {
      expect(Object.hasOwn(controller, method)).toBe(true);
    }
    // The browser half disappears if the row is replaced rather than wrapped,
    // so the stock methods must stay exactly where the gateway describes them.
    for (const method of ["environment", "list", "retain", "rename", "close"]) {
      expect(Object.hasOwn(controller, method)).toBe(false);
      expect(Reflect.get(controller, method)).toBe(
        Reflect.get(FakeTerminalController.prototype, method),
      );
    }

    undo();
    for (const method of WRAPPED) {
      expect(Object.hasOwn(controller, method)).toBe(false);
    }
    expect(Reflect.get(typed, "attach")).toBe(
      Reflect.get(FakeTerminalController.prototype, "attach"),
    );
  });
});
