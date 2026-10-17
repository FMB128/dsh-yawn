import { AsyncLocalStorage } from "node:async_hooks";
import { posix } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { WorkingDirectoryService } from "@deepseek-ai/dsh-working-directory";
import { describe, expect, it } from "vitest";

import { pathInSandbox } from "../src/sandbox-path.js";
import { useSandboxFrame } from "../src/working-directory.js";

const HOST_ANCHOR = "/data/.dsh-yawn/workspace-anchors/owner-repo";
const SANDBOX_ROOT = "/workspace/repository";
const DIRECTORIES = new Set([SANDBOX_ROOT, `${SANDBOX_ROOT}/src`]);

type Target = { readonly path: string };

interface FakeSession {
  header: { cwd: string };
  events: { type: string; data: { cwd: string } }[];
  append(type: string, data: { cwd: string }): void;
}

/**
 * Drives the real stock service with fakes for the three services it injects.
 * The filesystem behaves like `SandboxFileSystem`: every call needs an
 * initiating agent, and the session's host anchor maps onto the sandbox
 * workspace.
 */
function drive() {
  const ctx = new Context();
  const storage = new AsyncLocalStorage<Agent>();
  const agents = {
    currentInitiator: () => storage.getStore(),
    withInitiator: <T>(initiator: Agent, operation: () => T): T =>
      storage.run(initiator, operation),
  };
  const initiators: Agent[] = [];
  const requireInitiator = (): Agent => {
    const agent = storage.getStore();
    if (agent === undefined) {
      throw new Error("no initiating Agent");
    }
    initiators.push(agent);
    return agent;
  };
  ctx.provide("fs", {
    resolve: async (path: string, options?: { cwd?: string }) => {
      const cwd = requireInitiator().session.header.cwd;
      const absolute = posix.resolve(options?.cwd ?? SANDBOX_ROOT, path);
      return { path: pathInSandbox(absolute, cwd, SANDBOX_ROOT) };
    },
    stat: async (target: Target) => {
      requireInitiator();
      return DIRECTORIES.has(target.path) ? { type: "directory" } : undefined;
    },
    processPath: (target: Target) => target.path,
  });
  ctx.provide("sessionProjections", {
    register: () => {},
    // The stock projection starts from the header's cwd.
    stateOf: (session: FakeSession) =>
      session.events.at(-1)?.data.cwd ?? session.header.cwd,
  });
  ctx.provide("systemPrompt", {
    context: () => {},
    getContextOrder: () => 100,
  });
  const service = new WorkingDirectoryService(ctx, {});
  const undo = useSandboxFrame(service, agents, () => SANDBOX_ROOT);

  const session: FakeSession = {
    header: { cwd: HOST_ANCHOR },
    events: [],
    append(type, data) {
      this.events.push({ type, data });
    },
  };
  const notices: unknown[] = [];
  const agent = {
    session,
    ctx: { fiber: { assertActive: () => {} } },
    inject: (message: unknown) => notices.push(message),
  } as unknown as Agent;
  return { agents, service, undo, agent, session, initiators, notices };
}

describe("working directory in sandbox paths", () => {
  it("reports the sandbox workspace for a session that starts at the host anchor", () => {
    const { service, agent } = drive();

    expect(service.get(agent.session)).toBe(SANDBOX_ROOT);
  });

  it("validates the sandbox path inside an agent turn", async () => {
    const { agents, service, agent, session, initiators } = drive();

    const cwd = await agents.withInitiator(agent, () => service.ensure(agent));

    expect(cwd).toBe(SANDBOX_ROOT);
    expect(session.events).toEqual([]);
    expect(initiators).not.toHaveLength(0);
    expect(initiators.every((initiator) => initiator === agent)).toBe(true);
  });

  it("answers outside a turn without reaching the sandbox", async () => {
    const { service, agent, session, initiators } = drive();

    await expect(service.ensure(agent)).resolves.toBe(SANDBOX_ROOT);
    expect(initiators).toEqual([]);
    expect(session.events).toEqual([]);
  });

  it("changes directory as the agent it serves, relative to the sandbox path", async () => {
    const { service, agent, initiators, notices } = drive();

    await expect(service.set(agent, "src")).resolves.toBe(
      `${SANDBOX_ROOT}/src`,
    );
    expect(service.get(agent.session)).toBe(`${SANDBOX_ROOT}/src`);
    expect(initiators.every((initiator) => initiator === agent)).toBe(true);
    expect(JSON.stringify(notices)).not.toContain(HOST_ANCHOR);
  });

  it("restores the stock methods when the row is disposed", () => {
    const { service, undo, agent } = drive();

    undo();

    expect(service.get(agent.session)).toBe(HOST_ANCHOR);
  });
});
