import { Context } from "@deepseek-ai/cordis";
import type { SubprocessTerminalSpawnSpec } from "@deepseek-ai/dsh-subprocess";
import { BashTerminalBackend } from "@deepseek-ai/dsh-terminal-bash";
import { describe, expect, it } from "vitest";

import { SandboxPolicy } from "../../src/sandbox-policy.js";

const SANDBOX_WORKSPACE = "/workspace/repository";
const HOST_ANCHOR = "/data/.dsh-yawn/workspace-anchors/owner-repo";
/** Where the dsh host's own sandbox provider keeps its confinement launcher. */
const HOST_LANDLOCK_LAUNCHER =
  "/opt/dsh-yawn/cli/node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/landlock-run";

/**
 * Stands in for the host's `dsh-sandbox-local`: it wraps the command in the
 * host's `landlock-run` launcher, the way a real control plane does. The
 * sandbox cannot run that launcher, so any call recorded here is a bug.
 */
function confinementStub() {
  const calls: string[][] = [];
  return {
    calls,
    confine(argv: readonly string[]): Promise<{ argv: string[] }> {
      calls.push([...argv]);
      return Promise.resolve({ argv: [HOST_LANDLOCK_LAUNCHER, "--", ...argv] });
    },
  };
}

/**
 * Drives the real `dsh-terminal-bash` backend — the shell behind the shipped
 * `minimal` preset — with this package's policy service. The backend wraps the
 * shell in the host's `landlock-run` launcher unless the policy answers full
 * access, and the sandbox cannot run that launcher: every command in a
 * `minimal` session used to fail here with ENOENT. The stub provider records
 * such a wrap, so this test fails if the policy ever answers a confined mode
 * again.
 */
describe("persistent shell in a sandbox session", () => {
  function drive() {
    const ctx = new Context();
    ctx.provide("sandboxManager", { workspace: SANDBOX_WORKSPACE });
    const policy = new SandboxPolicy(ctx);
    const sandbox = confinementStub();
    const spawned: SubprocessTerminalSpawnSpec[] = [];
    const backendContext = {
      sandboxPolicy: policy,
      terminals: {},
      sessionProjections: {},
      // In a session this is dsh's working-directory service as
      // `working-directory.ts` wraps it: the sandbox workspace.
      workingDirectory: { ensure: () => Promise.resolve(SANDBOX_WORKSPACE) },
      get: (name: string) => (name === "sandbox" ? sandbox : undefined),
    };
    const backend = new BashTerminalBackend(
      backendContext as unknown as Context,
      {
        backendType: "shell",
        shellDialect: "bash",
        shellPath: "/bin/bash",
        shellArgs: ["--noprofile", "--norc", "-i"],
        rows: 40,
        cols: 160,
        timeoutMs: 30_000,
        disposeGraceMs: 3_000,
      } as never,
      (spec) => {
        spawned.push(spec);
        return Promise.resolve({} as never);
      },
      () => ({ initialize: () => Promise.resolve() }) as never,
    );
    const owner = {
      id: "owner-one",
      session: { id: "session-one", header: { cwd: HOST_ANCHOR } },
      ctx: { on: () => {} },
    };
    return { backend, owner, sandbox, spawned };
  }

  it("spawns the shell itself, without the host confinement launcher", async () => {
    const { backend, owner, sandbox, spawned } = drive();

    await backend.spawn({
      owner,
      sessionId: "terminal-one",
      rows: 40,
      cols: 160,
    } as never);

    expect(sandbox.calls).toEqual([]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.argv).toEqual([
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-i",
    ]);
    // No caller-supplied cwd: the shell starts in the session's directory.
    expect(spawned[0]?.cwd).toBe(SANDBOX_WORKSPACE);
  });
});
