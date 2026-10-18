import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context, Service } from "@deepseek-ai/cordis";
import { agentEvents, type Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CredentialBroker, GLOBAL_SECRET_SCOPE } from "../src/broker.js";
import { SandboxManager } from "../src/manager/index.js";
import { SessionStore } from "../src/state-store.js";
import {
  FakeBackend,
  FakeWorkspaceRegistry,
  gatewayFor,
  sleep,
} from "./fakes.js";

describe("sandbox lifecycle", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-yawn-control-plane-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("provisions, hibernates, and wakes one sandbox per session", async () => {
    const backend = new FakeBackend();
    const ctx = new Context();
    const manager = new SandboxManager(
      ctx,
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/public.git",
        // Idling is not this test's subject, and it asserts exact provision
        // and wake counts around real broker file I/O: a 10ms window let the
        // idle policy hibernate mid-test, which added a second wake.
        idleMs: 60_000,
        expiresAfterMs: 60_000,
      },
      { backends: { standard: backend }, gateway: gatewayFor(backend) },
    );
    const agent = {
      id: "session-one",
      session: { header: {} },
    } as unknown as Agent;

    expect(manager.workspace).toBe("/workspace/repository");
    await manager.ensureRunning(agent);
    await manager.ensureRunning(agent);
    expect(backend.provisions).toBe(1);
    expect(backend.client.setups).toBe(1);
    expect(backend.expiries).toBe(0);

    const cliBroker = new CredentialBroker({
      path: join(directory, "broker.json"),
    });
    await cliBroker.initialize();
    await cliBroker.setSecret(
      GLOBAL_SECRET_SCOPE,
      "UPDATED_IN_CLI",
      "available-on-next-command",
    );
    await manager.ensureRunning(agent);
    expect(backend.client.secrets).toEqual({
      UPDATED_IN_CLI: "available-on-next-command",
    });

    backend.running = false;
    backend.client.healthy = false;
    await manager.ensureRunning(agent);
    expect(backend.provisions).toBe(1);
    expect(backend.wakes).toBe(1);

    await manager.hibernate("session-one");
    expect(backend.expiries).toBe(1);
    await manager.ensureRunning(agent);
    expect(backend.hibernations).toBe(1);
    expect(backend.wakes).toBe(2);
    expect(backend.client.setups).toBe(3);
  });

  it("releases a session's sandbox on demand and is a no-op when absent", async () => {
    const backend = new FakeBackend();
    const ctx = new Context();
    const manager = new SandboxManager(
      ctx,
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/public.git",
        idleMs: 60_000,
        expiresAfterMs: 60_000,
      },
      { backends: { standard: backend }, gateway: gatewayFor(backend) },
    );
    const agent = {
      id: "session-one",
      session: { header: {} },
    } as unknown as Agent;

    await manager.ensureRunning(agent);
    expect(backend.provisions).toBe(1);

    await manager.release("session-one");
    expect(backend.running).toBe(false);
    const store = new SessionStore(join(directory, "sessions.json"));
    await store.initialize();
    expect(store.get("session-one")).toBeUndefined();

    // Releasing again is a no-op; the next turn provisions a fresh sandbox.
    await manager.release("session-one");
    await manager.ensureRunning(agent);
    expect(backend.provisions).toBe(2);
  });

  it("does not release a sandbox under a live turn", async () => {
    const backend = new FakeBackend();
    const ctx = new Context();
    const manager = new SandboxManager(
      ctx,
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/public.git",
        idleMs: 60_000,
        expiresAfterMs: 60_000,
      },
      { backends: { standard: backend }, gateway: gatewayFor(backend) },
    );
    const agent = {
      id: "session-one",
      session: { header: {} },
    } as unknown as Agent;
    const session = { id: "session-one" } as unknown as Session;

    await manager.ensureRunning(agent);
    ctx.emit("session/event", session, {
      type: "turn/start",
      data: { turn: 1 },
    } as unknown as SessionEvent);
    await manager.release("session-one");
    expect(backend.running).toBe(true);
    const store = new SessionStore(join(directory, "sessions.json"));
    await store.initialize();
    expect(store.get("session-one")?.state).toBe("running");

    // The caller re-triggers after turn/end, and only then does release run.
    ctx.emit("session/event", session, {
      type: "turn/end",
      data: { turn: 1, reason: { kind: "completed" } },
    } as unknown as SessionEvent);
    await manager.release("session-one");
    expect(backend.running).toBe(false);
    const released = new SessionStore(join(directory, "sessions.json"));
    await released.initialize();
    expect(released.get("session-one")).toBeUndefined();
  });

  it("suspends a session woken without a turn once its idle timer fires", async () => {
    const backend = new FakeBackend();
    const ctx = new Context();
    const manager = new SandboxManager(
      ctx,
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/public.git",
        idleMs: 10,
        expiresAfterMs: 60_000,
      },
      { backends: { standard: backend }, gateway: gatewayFor(backend) },
    );
    const agent = {
      id: "session-one",
      session: { header: {} },
    } as unknown as Agent;

    // Provision, then wake again the way a Web UI session list does: the
    // cached client answers, no turn runs, and only a re-armed timer can
    // ever suspend the sandbox.
    await manager.ensureRunning(agent);
    await manager.ensureRunning(agent);
    expect(backend.provisions).toBe(1);

    await sleep(100);
    expect(backend.hibernations).toBe(1);
    const store = new SessionStore(join(directory, "sessions.json"));
    await store.initialize();
    const hibernated = store.get("session-one");
    expect(hibernated?.state).toBe("hibernated");
    // The expiry countdown only starts when hibernation happens.
    expect(
      hibernated?.state !== "running" && hibernated?.expiresAt,
    ).toBeTruthy();

    // Waking the hibernated session re-arms instead of running forever.
    await manager.ensureRunning(agent);
    expect(backend.wakes).toBe(1);
    await sleep(100);
    expect(backend.hibernations).toBe(2);
  });

  it("uses the profile's own idle delay over the top-level one", async () => {
    const backend = new FakeBackend();
    const manager = new SandboxManager(
      new Context(),
      {
        profiles: { standard: { backend: "docker", idleMs: 60_000 } },
        stateDir: directory,
        repository: "https://github.com/example/public.git",
        idleMs: 10,
        expiresAfterMs: 60_000,
      },
      { backends: { standard: backend }, gateway: gatewayFor(backend) },
    );
    const agent = {
      id: "session-one",
      session: { header: {} },
    } as unknown as Agent;

    await manager.ensureRunning(agent);
    await sleep(100);
    expect(backend.hibernations).toBe(0);
  });

  it("does not suspend under a live turn and suspends after turn/end", async () => {
    const backend = new FakeBackend();
    const ctx = new Context();
    const manager = new SandboxManager(
      ctx,
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/public.git",
        idleMs: 10,
        expiresAfterMs: 60_000,
      },
      { backends: { standard: backend }, gateway: gatewayFor(backend) },
    );
    const agent = {
      id: "session-one",
      session: { header: {} },
    } as unknown as Agent;
    const session = { id: "session-one" } as unknown as Session;

    await manager.ensureRunning(agent);
    ctx.emit("session/event", session, {
      type: "turn/start",
      data: { turn: 1 },
    } as unknown as SessionEvent);
    await sleep(100);
    expect(backend.hibernations).toBe(0);

    ctx.emit("session/event", session, {
      type: "turn/end",
      data: { turn: 1, reason: { kind: "completed" } },
    } as unknown as SessionEvent);
    await sleep(100);
    expect(backend.hibernations).toBe(1);
  });

  it("keeps a running sandbox awake across terminal activity", async () => {
    const backend = new FakeBackend();
    const ctx = new Context();
    const manager = new SandboxManager(
      ctx,
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/public.git",
        idleMs: 100,
        expiresAfterMs: 60_000,
      },
      { backends: { standard: backend }, gateway: gatewayFor(backend) },
    );
    const agent = {
      id: "session-one",
      session: { header: {} },
    } as unknown as Agent;

    await manager.ensureRunning(agent);
    // Keystrokes arrive faster than the countdown, as they do in a terminal
    // someone is typing in.
    for (let keystroke = 0; keystroke < 10; keystroke += 1) {
      await sleep(30);
      manager.noteActivity(agent);
    }
    expect(backend.hibernations).toBe(0);

    // With the terminal untouched the countdown runs out as usual.
    await sleep(300);
    expect(backend.hibernations).toBe(1);
  });

  it("ignores terminal activity for a session with no running sandbox", async () => {
    const backend = new FakeBackend();
    const ctx = new Context();
    const manager = new SandboxManager(
      ctx,
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/public.git",
        idleMs: 10,
        expiresAfterMs: 60_000,
      },
      { backends: { standard: backend }, gateway: gatewayFor(backend) },
    );
    const agent = {
      id: "session-one",
      session: { header: {} },
    } as unknown as Agent;

    manager.noteActivity(agent);
    await sleep(50);
    expect(backend.provisions).toBe(0);
    expect(backend.hibernations).toBe(0);
  });

  it("serves subagent sessions from the root session's sandbox", async () => {
    const backend = new FakeBackend();
    const ctx = new Context();
    const parent = {
      id: "session-one",
      session: { header: {} },
    } as unknown as Agent;
    const child = {
      id: "subagent-one",
      session: { header: { parentSession: "session-one", origin: "subagent" } },
    } as unknown as Agent;
    const manager = new SandboxManager(
      ctx,
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/public.git",
        idleMs: 60_000,
        expiresAfterMs: 60_000,
      },
      {
        backends: { standard: backend },
        gateway: gatewayFor(backend),
        agentLookup: (sessionId) =>
          sessionId === "session-one"
            ? parent
            : sessionId === "subagent-one"
              ? child
              : undefined,
      },
    );

    // The child's first tool call boots the root's sandbox; no second
    // sandbox is provisioned for the child session.
    await manager.ensureRunning(parent);
    await manager.ensureRunning(child);
    expect(backend.provisions).toBe(1);

    const store = new SessionStore(join(directory, "sessions.json"));
    await store.initialize();
    expect(store.get("session-one")?.state).toBe("running");
    expect(store.get("subagent-one")).toBeUndefined();

    // A live child turn holds the shared sandbox, exactly as a parent turn
    // would: release waits for the turn to close.
    const childSession = { id: "subagent-one" } as unknown as Session;
    ctx.emit("session/event", childSession, {
      type: "turn/start",
      data: { turn: 1 },
    } as unknown as SessionEvent);
    await manager.release("session-one");
    expect(backend.running).toBe(true);

    ctx.emit("session/event", childSession, {
      type: "turn/end",
      data: { turn: 1, reason: { kind: "completed" } },
    } as unknown as SessionEvent);
    await manager.release("session-one");
    expect(backend.running).toBe(false);
  });

  it("keeps the shared sandbox live while a parent and child turn overlap", async () => {
    const backend = new FakeBackend();
    const ctx = new Context();
    const parent = {
      id: "session-one",
      session: { header: {} },
    } as unknown as Agent;
    const child = {
      id: "subagent-one",
      session: { header: { parentSession: "session-one", origin: "subagent" } },
    } as unknown as Agent;
    const manager = new SandboxManager(
      ctx,
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/public.git",
        idleMs: 60_000,
        expiresAfterMs: 60_000,
      },
      {
        backends: { standard: backend },
        gateway: gatewayFor(backend),
        agentLookup: (sessionId) =>
          sessionId === "session-one"
            ? parent
            : sessionId === "subagent-one"
              ? child
              : undefined,
      },
    );
    await manager.ensureRunning(parent);

    // Parent turn opens, background child turn opens, child turn closes:
    // the root must stay live under the parent's still-open turn.
    const parentSession = { id: "session-one" } as unknown as Session;
    const childSession = { id: "subagent-one" } as unknown as Session;
    ctx.emit("session/event", parentSession, {
      type: "turn/start",
      data: { turn: 1 },
    } as unknown as SessionEvent);
    ctx.emit("session/event", childSession, {
      type: "turn/start",
      data: { turn: 1 },
    } as unknown as SessionEvent);
    ctx.emit("session/event", childSession, {
      type: "turn/end",
      data: { turn: 1, reason: { kind: "completed" } },
    } as unknown as SessionEvent);
    await manager.release("session-one");
    expect(backend.running).toBe(true);

    ctx.emit("session/event", parentSession, {
      type: "turn/end",
      data: { turn: 1, reason: { kind: "completed" } },
    } as unknown as SessionEvent);
    await manager.release("session-one");
    expect(backend.running).toBe(false);
  });

  it("keeps a subagent on its root sandbox after the root stops resolving", async () => {
    const backend = new FakeBackend();
    const ctx = new Context();
    const parent = {
      id: "session-one",
      session: { header: {} },
    } as unknown as Agent;
    const child = {
      id: "subagent-one",
      session: { header: { parentSession: "session-one", origin: "subagent" } },
    } as unknown as Agent;
    // The registry is live at resolution time; the Web UI can dispose a
    // top-level agent while a continuable child keeps running.
    let parentLive = true;
    const manager = new SandboxManager(
      ctx,
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/public.git",
        idleMs: 60_000,
        expiresAfterMs: 60_000,
      },
      {
        backends: { standard: backend },
        gateway: gatewayFor(backend),
        agentLookup: (sessionId) =>
          sessionId === "subagent-one"
            ? child
            : sessionId === "session-one" && parentLive
              ? parent
              : undefined,
      },
    );
    await manager.ensureRunning(child);
    expect(backend.provisions).toBe(1);

    // Root disposed mid-run: the memoized root keeps the child on the same
    // sandbox instead of silently booting a fresh one from origin HEAD.
    parentLive = false;
    await manager.ensureRunning(child);
    expect(backend.provisions).toBe(1);
    const store = new SessionStore(join(directory, "sessions.json"));
    await store.initialize();
    expect(store.get("session-one")?.state).toBe("running");
    expect(store.get("subagent-one")).toBeUndefined();
  });

  it("gives a fork child its own sandbox while the source is live", async () => {
    const backend = new FakeBackend();
    const ctx = new Context();
    const source = {
      id: "session-source",
      session: { header: {} },
    } as unknown as Agent;
    // dsh records the fork source in `parentSession` and never sets `origin`,
    // so a fork child is a top-level session with its own sandbox.
    const child = {
      id: "session-fork",
      session: { header: { parentSession: "session-source", isSeeded: true } },
    } as unknown as Agent;
    const manager = new SandboxManager(
      ctx,
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/public.git",
        idleMs: 60_000,
        expiresAfterMs: 60_000,
      },
      {
        backends: { standard: backend },
        gateway: gatewayFor(backend),
        agentLookup: (sessionId) =>
          sessionId === "session-source"
            ? source
            : sessionId === "session-fork"
              ? child
              : undefined,
      },
    );
    await manager.ensureRunning(source);
    await manager.hibernate("session-source");
    expect(backend.hibernations).toBe(1);

    // Starting the fork must not wake the source's hibernated sandbox.
    await manager.ensureRunning(child);
    expect(backend.provisions).toBe(2);
    expect(backend.wakes).toBe(0);

    const store = new SessionStore(join(directory, "sessions.json"));
    await store.initialize();
    expect(store.get("session-source")?.state).toBe("hibernated");
    expect(store.get("session-fork")?.state).toBe("running");
  });

  it("leaves provisioning and waking to the first prompt, not session-start", async () => {
    const backend = new FakeBackend();
    const ctx = new Context();
    const manager = new SandboxManager(
      ctx,
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/public.git",
        idleMs: 10,
        expiresAfterMs: 60_000,
      },
      { backends: { standard: backend }, gateway: gatewayFor(backend) },
    );
    const agent = {
      id: "session-one",
      session: { header: {} },
    } as unknown as Agent;

    // A blank session exists before the user has picked a profile, and every
    // UI action that resolves a cold session resumes it. Neither may schedule
    // a sandbox; the first pre-step does, through ensureRunning.
    agentEvents(ctx, agent).emit("agent/created", { source: "startup" });
    agentEvents(ctx, agent).emit("agent/created", { source: "resume" });
    await sleep(50);
    expect(backend.provisions).toBe(0);
    expect(backend.wakes).toBe(0);

    await manager.ensureRunning(agent);
    expect(backend.provisions).toBe(1);

    // A resume of a hibernated session leaves it hibernated.
    await manager.hibernate("session-one");
    agentEvents(ctx, agent).emit("agent/created", { source: "resume" });
    await sleep(50);
    expect(backend.wakes).toBe(0);
    const store = new SessionStore(join(directory, "sessions.json"));
    await store.initialize();
    expect(store.get("session-one")?.state).toBe("hibernated");
  });

  it("reports whether a session has a sandbox without provisioning one", async () => {
    const backend = new FakeBackend();
    const ctx = new Context();
    const manager = new SandboxManager(
      ctx,
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/public.git",
      },
      { backends: { standard: backend }, gateway: gatewayFor(backend) },
    );
    const agent = {
      id: "session-one",
      session: { header: {} },
    } as unknown as Agent;

    expect(await manager.hasSandbox(agent)).toBe(false);
    expect(backend.provisions).toBe(0);
    expect(backend.wakes).toBe(0);

    await manager.ensureRunning(agent);
    expect(await manager.hasSandbox(agent)).toBe(true);
    expect(backend.provisions).toBe(1);
  });

  it("tells the model its workspace was restored from a checkpoint, once", async () => {
    const backend = new FakeBackend();
    backend.capabilities.supportsHibernate = false;
    const ctx = new Context();
    const manager = new SandboxManager(
      ctx,
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/public.git",
        idleMs: 60_000,
        expiresAfterMs: 60_000,
      },
      { backends: { standard: backend }, gateway: gatewayFor(backend) },
    );
    const agent = {
      id: "session-one",
      session: { header: {}, events: [], surface: { nodes: [] } },
    } as unknown as Agent;
    const prompt = createUserMessage({
      content: [{ type: "text", text: "Continue the work." }],
      source: { kind: "user" },
    });
    const preStep = () =>
      agentEvents(ctx, agent).waterfall(
        "agent/pre-step",
        {
          messages: [prompt],
          turn: 1,
          step: 1,
          signal: new AbortController().signal,
        },
        () => Promise.resolve({ kind: "enter" as const, messages: [prompt] }),
      );

    // The backend cannot hibernate, so idling saves the tree and destroys
    // the sandbox; the next turn's pre-step restores it into a fresh one.
    await manager.ensureRunning(agent);
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const bundle = new TextEncoder().encode("# v2 git bundle\nobjects");
    backend.client.execReplies.push({
      stdout: new Uint8Array([
        ...new TextEncoder().encode(`feature\n${commit}\n`),
        ...bundle,
      ]),
    });
    // The artifacts script runs after the Git save and finds nothing to carry.
    backend.client.execReplies.push({ stdout: "0\n" });
    await manager.hibernate("session-one");
    expect(backend.destroys).toBe(1);

    // The restore turn's prompt carries the notice ahead of the user's text.
    const restored = await preStep();
    expect(restored).toMatchObject({
      kind: "enter",
      messages: [
        {
          content: [
            {
              type: "text",
              text: "This sandbox was recreated. Your Git changes and commits are back. The repository's setup (`.agents/setup`) ran before the restore, so re-run project steps if your restored changes affect them. Anything you installed yourself, ignored files, and everything else outside the repository are gone. Previously staged changes are now unstaged.",
            },
          ],
          source: {
            kind: "dsh-yawn",
            form: "notice",
          },
        },
        prompt,
      ],
    });

    // The turn after the restore reports nothing.
    const following = await preStep();
    expect(following).toEqual({ kind: "enter", messages: [prompt] });
  });

  it("tells the model when the checkpoint had to leave the artifacts behind", async () => {
    const backend = new FakeBackend();
    backend.capabilities.supportsHibernate = false;
    const ctx = new Context();
    const manager = new SandboxManager(
      ctx,
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/public.git",
        // A workspace that is not the default, so the notice proves it names
        // the session's own artifacts folder rather than a fixed path.
        workspace: "/custom/repository",
        idleMs: 60_000,
        expiresAfterMs: 60_000,
      },
      { backends: { standard: backend }, gateway: gatewayFor(backend) },
    );
    const agent = {
      id: "session-one",
      session: { header: {}, events: [], surface: { nodes: [] } },
    } as unknown as Agent;
    const prompt = createUserMessage({
      content: [{ type: "text", text: "Continue the work." }],
      source: { kind: "user" },
    });
    const preStep = () =>
      agentEvents(ctx, agent).waterfall(
        "agent/pre-step",
        {
          messages: [prompt],
          turn: 1,
          step: 1,
          signal: new AbortController().signal,
        },
        () => Promise.resolve({ kind: "enter" as const, messages: [prompt] }),
      );

    await manager.ensureRunning(agent);
    backend.client.execReplies.push({
      stdout: new TextEncoder().encode(
        "feature\n0123456789abcdef0123456789abcdef01234567\n",
      ),
    });
    // The artifacts script fails after the Git save already came out.
    backend.client.execReplies.push({ exitCode: 1 });
    await manager.hibernate("session-one");

    const restored = await preStep();
    expect(restored).toMatchObject({
      kind: "enter",
      messages: [
        {
          content: [
            {
              type: "text",
              text: "This sandbox was recreated. Your Git changes and commits are back, but the artifacts folder could not be brought back, so the files in /custom/artifacts are gone. The repository's setup (`.agents/setup`) ran before the restore, so re-run project steps if your restored changes affect them. Anything you installed yourself, ignored files, and everything else outside the repository are gone. Previously staged changes are now unstaged.",
            },
          ],
          source: {
            kind: "dsh-yawn",
            form: "notice",
          },
        },
        prompt,
      ],
    });
  });

  it("tells the model its sandbox woke on a new machine, once", async () => {
    const backend = new FakeBackend();
    backend.capabilities.wakeKeepsFilesystem = false;
    const ctx = new Context();
    const manager = new SandboxManager(
      ctx,
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/public.git",
        idleMs: 60_000,
        expiresAfterMs: 60_000,
      },
      { backends: { standard: backend }, gateway: gatewayFor(backend) },
    );
    const agent = {
      id: "session-one",
      session: { header: {}, events: [], surface: { nodes: [] } },
    } as unknown as Agent;
    const prompt = createUserMessage({
      content: [{ type: "text", text: "Continue the work." }],
      source: { kind: "user" },
    });
    const preStep = () =>
      agentEvents(ctx, agent).waterfall(
        "agent/pre-step",
        {
          messages: [prompt],
          turn: 1,
          step: 1,
          signal: new AbortController().signal,
        },
        () => Promise.resolve({ kind: "enter" as const, messages: [prompt] }),
      );

    // The sandbox hibernates, then the next turn's pre-step wakes it.
    await manager.ensureRunning(agent);
    await manager.hibernate("session-one");
    expect(backend.hibernations).toBe(1);

    // The waking turn's prompt carries the notice ahead of the user's text.
    const woken = await preStep();
    expect(woken).toMatchObject({
      kind: "enter",
      messages: [
        {
          content: [
            {
              type: "text",
              text: "This sandbox was suspended and woke on a newly created machine. Files under /workspace survived, including your home directory, but running processes, /tmp, and anything you installed yourself outside /workspace are gone. The repository's setup (`.agents/setup`) ran again on this machine; re-create anything else you need before continuing.",
            },
          ],
          source: {
            kind: "dsh-yawn",
            form: "notice",
            summary: "Sandbox woke from hibernation",
          },
        },
        prompt,
      ],
    });

    // The turn after the wake reports nothing.
    const following = await preStep();
    expect(following).toEqual({ kind: "enter", messages: [prompt] });
  });

  it("tells the model a wake reused the machine when the backend keeps it", async () => {
    const backend = new FakeBackend();
    const ctx = new Context();
    const manager = new SandboxManager(
      ctx,
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/public.git",
        idleMs: 60_000,
        expiresAfterMs: 60_000,
      },
      { backends: { standard: backend }, gateway: gatewayFor(backend) },
    );
    const agent = {
      id: "session-one",
      session: { header: {}, events: [], surface: { nodes: [] } },
    } as unknown as Agent;
    const prompt = createUserMessage({
      content: [{ type: "text", text: "Continue the work." }],
      source: { kind: "user" },
    });
    const preStep = () =>
      agentEvents(ctx, agent).waterfall(
        "agent/pre-step",
        {
          messages: [prompt],
          turn: 1,
          step: 1,
          signal: new AbortController().signal,
        },
        () => Promise.resolve({ kind: "enter" as const, messages: [prompt] }),
      );

    await manager.ensureRunning(agent);
    await manager.hibernate("session-one");
    const woken = await preStep();

    expect(woken).toMatchObject({
      kind: "enter",
      messages: [
        {
          content: [
            {
              type: "text",
              text: "This sandbox was suspended and woke on the same machine. Its files are intact, but the processes that were running before the suspension are gone. Restart what you need before continuing.",
            },
          ],
          source: {
            kind: "dsh-yawn",
            form: "notice",
            summary: "Sandbox woke from hibernation",
          },
        },
        prompt,
      ],
    });
  });
});

describe("archive release", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-yawn-control-plane-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function persistedRecord(sessionId: string) {
    const store = new SessionStore(join(directory, "sessions.json"));
    return store.initialize().then(() => store.get(sessionId));
  }

  function managerConfig() {
    return {
      profiles: { standard: { backend: "docker" as const } },
      stateDir: directory,
      repository: "https://github.com/example/public.git",
      // Keep the idle policy out of the way: with a short window it could
      // hibernate before the archive reconcile this suite asserts on.
      idleMs: 60_000,
      expiresAfterMs: 60_000,
    };
  }

  it("releases the sandbox and its record when the session is archived", async () => {
    const backend = new FakeBackend();
    const workspaceRegistry = new FakeWorkspaceRegistry();
    const ctx = new Context();
    const manager = new SandboxManager(ctx, managerConfig(), {
      backends: { standard: backend },
      gateway: gatewayFor(backend),
      workspaceRegistry,
    });
    const agent = {
      id: "session-one",
      session: { header: {} },
    } as unknown as Agent;

    await manager.ensureRunning(agent);
    expect(await persistedRecord("session-one")).toBeDefined();

    workspaceRegistry.archivedSessionIds.push("session-one");
    ctx.emit("domain/changed", {
      domain: "workspace",
      table: "",
      key: "",
      operation: "put",
      value: {},
    });
    // The reconcile keeps working after the emit returns; poll for its
    // outcome instead of sleeping on it.
    await vi.waitFor(async () => {
      expect(await persistedRecord("session-one")).toBeUndefined();
    });

    expect(backend.destroys).toBe(1);
    expect(backend.hibernations).toBe(0);
    expect(backend.expiries).toBe(0);
  });

  it("releases archived sessions found at startup", async () => {
    // Seed the state file, then hand the manager a store whose load is held
    // until the test says so: the boot trigger must wait for the load instead
    // of reading an empty in-memory map. A future expiresAt keeps boot's own
    // expiry recovery out of the picture, so only the archive reconcile can
    // release the sandbox.
    const seed = new SessionStore(join(directory, "sessions.json"));
    await seed.initialize();
    await seed.set({
      sessionId: "session-one",
      backend: "fake",
      profile: "standard",
      sandboxId: "sandbox-one",
      reference: { id: "one" },
      repositoryUrl: "https://github.com/example/public",
      state: "hibernated",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let loadStore: () => void = () => {};
    const storeLoading = new Promise<void>((resolve) => {
      loadStore = resolve;
    });
    class GatedStore extends SessionStore {
      async initialize(): Promise<void> {
        await storeLoading;
        return super.initialize();
      }
    }

    const backend = new FakeBackend();
    const ctx = new Context();
    await ctx.plugin(MountedWorkspaceRegistry);
    await sleep(20);
    (
      ctx.get("workspaceRegistry") as unknown as MountedWorkspaceRegistry
    ).fake.archivedSessionIds.push("session-one");

    const manager = new SandboxManager(ctx, managerConfig(), {
      backends: { standard: backend },
      store: new GatedStore(join(directory, "sessions.json")),
      gateway: gatewayFor(backend),
    });

    // Let the boot trigger's dispatch drain: the reconcile is parked on the
    // gated store, so nothing may be released while the load is held.
    await sleep(10);
    expect(backend.destroys).toBe(0);

    loadStore();
    // Settles once the host stores are loaded; the release itself no-ops on
    // the unknown session.
    await manager.release("unknown-session");
    // The reconcile keeps working after the stores settle; poll for its
    // outcome instead of sleeping on it.
    await vi.waitFor(async () => {
      expect(await persistedRecord("session-one")).toBeUndefined();
    });

    expect(backend.expiries).toBe(1);
    expect(backend.destroys).toBe(1);
  });
});

class MountedWorkspaceRegistry extends Service {
  static inject: string[] = [];
  readonly fake = new FakeWorkspaceRegistry();

  constructor(ctx: Context) {
    super(ctx, "workspaceRegistry");
  }

  get archivedSessionIds(): readonly string[] {
    return this.fake.archivedSessionIds;
  }

  async create(path: string, title?: string) {
    return this.fake.create(path, title);
  }

  list() {
    return this.fake.list();
  }
}

describe("repository workspaces and instructions", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-yawn-control-plane-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("registers a repository anchor before a Web session is created", async () => {
    const backend = new FakeBackend();
    const workspaceRegistry = new FakeWorkspaceRegistry();
    const ctx = new Context();
    const manager = new SandboxManager(
      ctx,
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/fallback.git",
      },
      {
        backends: { standard: backend },
        gateway: gatewayFor(backend),
        workspaceRegistry,
      },
    );
    const anchor = await manager.createRepositoryWorkspace(
      "https://github.com/example/public.git",
    );
    await manager.setGlobalInstructions("Use concise answers.");
    await manager.setWorkspaceInstructions(
      "https://github.com/example/public.git",
      "Run the repository tests.",
    );
    const agent = {
      id: "session-one",
      session: {
        header: { cwd: anchor },
        events: [],
        surface: { nodes: [] },
      },
    } as unknown as Agent;

    await manager.ensureRunning(agent);

    const emptyDecision = await agentEvents(ctx, agent).waterfall(
      "agent/pre-step",
      {
        messages: [],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      },
      () => Promise.resolve({ kind: "enter", messages: [] }),
    );
    const prompt = createUserMessage({
      content: [{ type: "text", text: "What instructions apply?" }],
      source: { kind: "user" },
    });
    const decision = await agentEvents(ctx, agent).waterfall(
      "agent/pre-step",
      {
        messages: [prompt],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      },
      () => Promise.resolve({ kind: "enter", messages: [prompt] }),
    );

    expect(workspaceRegistry.creates).toEqual([
      { path: anchor, title: "example/public" },
    ]);
    expect(backend.repositoryUrls).toEqual([
      "https://github.com/example/public",
    ]);
    expect(emptyDecision).toEqual({ kind: "enter", messages: [] });
    expect(await manager.getInstructions()).toEqual({
      global: "Use concise answers.",
      workspaces: [
        {
          repositoryUrl: "https://github.com/example/public",
          title: "example/public",
          content: "Run the repository tests.",
        },
      ],
    });
    expect(decision).toMatchObject({
      kind: "enter",
      messages: [
        prompt,
        {
          content: [
            {
              type: "text",
              // vitest types stringMatching as `any`.
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              text: expect.stringMatching(
                /Use concise answers[\s\S]*Run the repository tests/,
              ),
            },
          ],
          source: {
            kind: "dsh-yawn",
            form: "instructions",
          },
        },
      ],
    });
    await expect(
      manager.setWorkspaceInstructions(
        "https://github.com/example/unknown",
        "Do not save this.",
      ),
    ).rejects.toThrow("not registered");
    expect(
      (
        ctx.get("directoryPicker") as { capability(): { kind: string } }
      ).capability().kind,
    ).toBe("repository");
  });

  it("scopes secrets per workspace and pushes the effective set to the runner", async () => {
    const backend = new FakeBackend();
    const workspaceRegistry = new FakeWorkspaceRegistry();
    const manager = new SandboxManager(
      new Context(),
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/fallback.git",
      },
      {
        backends: { standard: backend },
        gateway: gatewayFor(backend),
        workspaceRegistry,
      },
    );
    const anchor = await manager.createRepositoryWorkspace(
      "https://github.com/example/public.git",
    );

    await manager.setGlobalSecret("API_KEY", "global");
    await manager.setGlobalSecret("GITHUB_TOKEN", "global-pat");
    // The URL without ".git" normalizes to the anchor's repository URL.
    await manager.setWorkspaceSecret(
      "https://github.com/example/public",
      "API_KEY",
      "workspace",
    );
    await manager.setWorkspaceSecret(
      "https://github.com/example/public",
      "GITHUB_TOKEN",
      "workspace-pat",
    );

    expect(await manager.getSecrets()).toEqual({
      global: ["API_KEY", "GITHUB_TOKEN"],
      workspaces: [
        {
          repositoryUrl: "https://github.com/example/public",
          title: "example/public",
          names: ["API_KEY", "GITHUB_TOKEN"],
        },
      ],
      gitHosts: [],
    });
    await expect(
      manager.setWorkspaceSecret(
        "https://github.com/example/unknown",
        "API_KEY",
        "x",
      ),
    ).rejects.toThrow("not registered");
    await expect(
      manager.deleteWorkspaceSecret(
        "https://github.com/example/unknown",
        "API_KEY",
      ),
    ).rejects.toThrow("not registered");

    await manager.ensureRunning({
      id: "session-one",
      session: { header: { cwd: anchor } },
    } as unknown as Agent);

    expect(backend.repositoryUrls).toEqual([
      "https://github.com/example/public",
    ]);
    expect(backend.client.secrets).toEqual({
      API_KEY: "workspace",
      GITHUB_TOKEN: "workspace-pat",
    });
    expect(backend.client.gitCredentials).toEqual([
      {
        host: "github.com",
        username: "x-access-token",
        password: "workspace-pat",
      },
    ]);
  });

  it("stores a new SSH workspace as HTTPS and serves its host", async () => {
    const backend = new FakeBackend();
    const workspaceRegistry = new FakeWorkspaceRegistry();
    const manager = new SandboxManager(
      new Context(),
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/fallback.git",
      },
      {
        backends: { standard: backend },
        gateway: gatewayFor(backend),
        workspaceRegistry,
      },
    );

    const anchor = await manager.createRepositoryWorkspace(
      "git@git.fml128.ch:FML128/repo.git",
    );
    await manager.setGlobalSecret("FORGE_TOKEN", "forge-pat");
    await manager.setGitHost("git.fml128.ch", "oauth2", "FORGE_TOKEN");

    expect((await manager.getSecrets()).gitHosts).toEqual([
      { host: "git.fml128.ch", username: "oauth2", secret: "FORGE_TOKEN" },
    ]);

    await manager.ensureRunning({
      id: "session-one",
      session: { header: { cwd: anchor } },
    } as unknown as Agent);

    expect(backend.repositoryUrls).toEqual([
      "https://git.fml128.ch/FML128/repo",
    ]);
    expect(backend.client.setupRepositoryUrls).toEqual([
      "https://git.fml128.ch/FML128/repo",
    ]);
    expect(backend.client.gitCredentials).toEqual([
      { host: "git.fml128.ch", username: "oauth2", password: "forge-pat" },
    ]);

    await manager.deleteGitHost("git.fml128.ch");
    expect((await manager.getSecrets()).gitHosts).toEqual([]);
  });

  it("uses a workspace-scoped secret for a converted workspace", async () => {
    const backend = new FakeBackend();
    const workspaceRegistry = new FakeWorkspaceRegistry();
    const manager = new SandboxManager(
      new Context(),
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/fallback.git",
      },
      {
        backends: { standard: backend },
        gateway: gatewayFor(backend),
        workspaceRegistry,
      },
    );

    const anchor = await manager.createRepositoryWorkspace(
      "git@git.fml128.ch:FML128/repo.git",
    );
    await manager.setWorkspaceSecret(
      "https://git.fml128.ch/FML128/repo",
      "FORGE_TOKEN",
      "workspace-pat",
    );
    await manager.setGitHost("git.fml128.ch", "oauth2", "FORGE_TOKEN");

    await manager.ensureRunning({
      id: "session-one",
      session: { header: { cwd: anchor } },
    } as unknown as Agent);

    expect(backend.client.setupRepositoryUrls).toEqual([
      "https://git.fml128.ch/FML128/repo",
    ]);
    expect(backend.client.gitCredentials).toEqual([
      { host: "git.fml128.ch", username: "oauth2", password: "workspace-pat" },
    ]);
  });

  it("rejects SSH URLs with a port, HTTP, and git:// workspaces", async () => {
    const backend = new FakeBackend();
    const manager = new SandboxManager(
      new Context(),
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/fallback.git",
      },
      {
        backends: { standard: backend },
        gateway: gatewayFor(backend),
        workspaceRegistry: new FakeWorkspaceRegistry(),
      },
    );

    await expect(
      manager.createRepositoryWorkspace(
        "ssh://git@git.fml128.ch:8443/FML128/repo.git",
      ),
    ).rejects.toThrow("HTTPS");
    await expect(
      manager.createRepositoryWorkspace("http://git.fml128.ch/FML128/repo"),
    ).rejects.toThrow("HTTPS");
    await expect(
      manager.createRepositoryWorkspace("git://git.fml128.ch/FML128/repo"),
    ).rejects.toThrow("HTTPS");
  });

  it("does not create repository anchors without the Web workspace service", async () => {
    const manager = new SandboxManager(
      new Context(),
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/fallback",
      },
      (() => {
        const backend = new FakeBackend();
        return {
          backends: { standard: backend },
          gateway: gatewayFor(backend),
        };
      })(),
    );
    await manager.ensureRunning({
      id: "headless-session",
      session: { header: {} },
    } as unknown as Agent);

    await expect(
      manager.createRepositoryWorkspace("https://github.com/example/public"),
    ).rejects.toThrow("Web profile");
    await expect(stat(join(directory, "workspace-anchors"))).rejects.toThrow();
  });

  it("prepares backends at boot and keeps the runner token across restarts", async () => {
    const boot = async (backend: FakeBackend) => {
      const ctx = new Context();
      const manager = new SandboxManager(
        ctx,
        {
          profiles: { standard: { backend: "docker" } },
          stateDir: directory,
          repository: "https://github.com/example/public.git",
        },
        { backends: { standard: backend }, gateway: gatewayFor(backend) },
      );
      // Any host call waits for boot.
      await manager.getSecrets();
      await ctx.fiber.dispose();
      return readFile(join(directory, "registration-token"), "utf8");
    };

    const first = new FakeBackend();
    const token = await boot(first);
    expect(first.preparations).toBe(1);
    expect(token.trim()).toMatch(/^[0-9a-f]{64}$/);

    // Sandboxes started before the restart still hold the stored token.
    expect(await boot(new FakeBackend())).toBe(token);
  });
});

describe("Scratch workspace", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-yawn-control-plane-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function boot(backend: FakeBackend, ctx = new Context()) {
    const workspaceRegistry = new FakeWorkspaceRegistry();
    const manager = new SandboxManager(
      ctx,
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        // The fallback a session outside any anchor would use; the Scratch
        // Workspace must not.
        repository: "https://github.com/example/fallback.git",
        idleMs: 60_000,
        expiresAfterMs: 60_000,
      },
      {
        backends: { standard: backend },
        gateway: gatewayFor(backend),
        workspaceRegistry,
      },
    );
    return { manager, workspaceRegistry };
  }

  function sessionIn(cwd: string): Agent {
    return {
      id: "session-one",
      session: { header: { cwd }, events: [], surface: { nodes: [] } },
    } as unknown as Agent;
  }

  function preStep(ctx: Context, agent: Agent) {
    const prompt = createUserMessage({
      content: [{ type: "text", text: "Continue the work." }],
      source: { kind: "user" },
    });
    return agentEvents(ctx, agent).waterfall(
      "agent/pre-step",
      {
        messages: [prompt],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      },
      () => Promise.resolve({ kind: "enter" as const, messages: [prompt] }),
    );
  }

  it("lives in the state directory and is no settings scope", async () => {
    const { manager, workspaceRegistry } = boot(new FakeBackend());

    expect(manager.scratchWorkspace).toBe(
      join(await realpath(directory), "scratch"),
    );
    // Registered like any Workspace, but without a repository anchor.
    await workspaceRegistry.create(manager.scratchWorkspace, "Scratch");
    expect(await manager.getSecrets()).toEqual({
      global: [],
      workspaces: [],
      gitHosts: [],
    });
    expect(await manager.getInstructions()).toEqual({
      global: "",
      workspaces: [],
    });
  });

  it("starts sessions without a repository, with global secrets and instructions only", async () => {
    const backend = new FakeBackend();
    const ctx = new Context();
    const { manager } = boot(backend, ctx);
    const anchor = await manager.createRepositoryWorkspace(
      "https://github.com/example/public.git",
    );
    const path = manager.scratchWorkspace;
    await manager.setGlobalSecret("API_KEY", "global");
    await manager.setGlobalSecret("GITHUB_TOKEN", "global-pat");
    await manager.setWorkspaceSecret(
      "https://github.com/example/public",
      "API_KEY",
      "workspace",
    );
    await manager.setGlobalInstructions("Use concise answers.");
    await manager.setWorkspaceInstructions(
      "https://github.com/example/public",
      "Run the repository tests.",
    );
    const agent = sessionIn(path);
    expect(manager.inScratchWorkspace(agent)).toBe(true);
    expect(manager.inScratchWorkspace(sessionIn(anchor))).toBe(false);

    const decision = await preStep(ctx, agent);

    expect(backend.repositoryUrls).toEqual([""]);
    expect(backend.client.secrets).toEqual({
      API_KEY: "global",
      GITHUB_TOKEN: "global-pat",
    });
    // The global token still serves github.com clones.
    expect(backend.client.gitCredentials).toEqual([
      {
        host: "github.com",
        username: "x-access-token",
        password: "global-pat",
      },
    ]);
    const prompt = JSON.stringify(decision);
    expect(prompt).toContain("Use concise answers.");
    expect(prompt).not.toContain("Run the repository tests.");
  });

  it("checkpoints only the artifacts folder and says the rest is gone", async () => {
    const backend = new FakeBackend();
    backend.capabilities.supportsHibernate = false;
    const ctx = new Context();
    const { manager } = boot(backend, ctx);
    const agent = sessionIn(manager.scratchWorkspace);

    await manager.ensureRunning(agent);
    // The only script the save runs is the artifacts one: there is no Git
    // work to commit or bundle.
    const tar = new Uint8Array(2048);
    tar.set(new TextEncoder().encode("ustar"), 257);
    backend.client.execReplies.push({
      stdout: new Uint8Array([...new TextEncoder().encode("1\n"), ...tar]),
    });
    await manager.hibernate("session-one");
    expect(backend.destroys).toBe(1);
    expect(backend.client.execs).toHaveLength(1);
    expect(backend.client.execs[0]?.env).toHaveProperty(
      "DSH_YAWN_ARTIFACTS_DIR",
    );

    const restored = await preStep(ctx, agent);
    // The restore unpacks the artifacts and runs no Git restore.
    expect(backend.client.execs).toHaveLength(2);
    expect(new Uint8Array(backend.client.execs[1]?.stdin ?? [])).toEqual(tar);
    expect(backend.repositoryUrls).toEqual(["", ""]);
    expect(restored).toMatchObject({
      kind: "enter",
      messages: [
        {
          content: [
            {
              type: "text",
              text: "This sandbox was recreated on a new machine. The files in /workspace/artifacts are back. The rest of your working directory, anything you installed yourself, and everything else outside the artifacts folder are gone.",
            },
          ],
          source: { kind: "dsh-yawn", form: "notice" },
        },
        {},
      ],
    });
  });

  it("says nothing about repository setup when a session wakes on a new machine", async () => {
    const backend = new FakeBackend();
    backend.capabilities.wakeKeepsFilesystem = false;
    const ctx = new Context();
    const { manager } = boot(backend, ctx);
    const agent = sessionIn(manager.scratchWorkspace);

    await manager.ensureRunning(agent);
    await manager.hibernate("session-one");
    const woken = await preStep(ctx, agent);

    expect(woken).toMatchObject({
      kind: "enter",
      messages: [
        {
          content: [
            {
              type: "text",
              text: "This sandbox was suspended and woke on a newly created machine. Files under /workspace survived, including your home directory, but running processes, /tmp, and anything you installed yourself outside /workspace are gone. Re-create anything else you need before continuing.",
            },
          ],
          source: { kind: "dsh-yawn", form: "notice" },
        },
        {},
      ],
    });
  });
});
