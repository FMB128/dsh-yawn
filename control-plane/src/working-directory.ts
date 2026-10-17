/**
 * Keeps dsh's per-session working directory (`workingDirectory`) in sandbox
 * coordinates.
 *
 * Since dsh 0.2.1 one service owns each session's current directory. Tools
 * take their cwd from it, the model reads it in every request as "Current
 * working directory: <path>", and the `working_directory` tool changes it.
 * It starts from the session header's cwd, which here is the control plane's
 * bookkeeping anchor: a host path that does not exist inside the sandbox.
 * Tools would still work, because this package's filesystem and subprocess
 * map that anchor onto the sandbox workspace, but the model would be told a
 * host path, and a `cd` to it in a shell would fail.
 *
 * This module keeps the stock row mounted and wraps its methods on the live
 * service:
 *
 * - `get` maps the anchor, and any path under it, onto the sandbox
 *   workspace. The stock service reads its own directory through `get`, so
 *   the prompt line, the directory it validates, and the one it records for
 *   the session all come out in sandbox coordinates.
 * - `ensure` and `set` read the sandbox filesystem, which finds its sandbox
 *   through the initiating agent. Inside an agent turn they run as the agent
 *   they were given. Outside one, such as the composer's skill list for an
 *   open session, `ensure` answers the recorded directory without checking
 *   it, so loading a page does not wake a hibernated sandbox; the next turn
 *   checks it. `set` always runs as its agent, because it must validate.
 *
 * The wrappers are own properties on the service instance, so disposing the
 * row restores the stock methods.
 *
 * @module @zhming0/dsh-yawn/working-directory
 */

import { symbols, type Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Session } from "@deepseek-ai/dsh-session";
import type { WorkingDirectoryService } from "@deepseek-ai/dsh-working-directory";

import { pathInSandbox } from "./sandbox-path.js";

type Initiators = Pick<Context["agents"], "currentInitiator" | "withInitiator">;

type StockGet = (this: WorkingDirectoryService, session: Session) => string;
type StockEnsure = (
  this: WorkingDirectoryService,
  agent: Agent,
  signal?: AbortSignal,
) => Promise<string>;
type StockSet = (
  this: WorkingDirectoryService,
  agent: Agent,
  path: string,
  signal?: AbortSignal,
) => Promise<string>;

/**
 * Wrap the live `workingDirectory` service so it speaks sandbox paths and
 * reaches the sandbox as the agent it serves. Returns the undo.
 * @param directories - the service instance, with any cordis proxy removed.
 * @param sandboxWorkspace - the session workspace's path inside the sandbox.
 */
export function useSandboxFrame(
  directories: WorkingDirectoryService,
  agents: Initiators,
  sandboxWorkspace: () => string,
): () => void {
  const stockGet: StockGet = Reflect.get(directories, "get");
  const stockEnsure: StockEnsure = Reflect.get(directories, "ensure");
  const stockSet: StockSet = Reflect.get(directories, "set");

  const wrappers = {
    get(this: WorkingDirectoryService, session: Session): string {
      return pathInSandbox(
        stockGet.call(this, session),
        session.header.cwd,
        sandboxWorkspace(),
      );
    },
    ensure(
      this: WorkingDirectoryService,
      agent: Agent,
      signal?: AbortSignal,
    ): Promise<string> {
      if (agents.currentInitiator() === undefined) {
        return Promise.resolve(this.get(agent.session));
      }
      return agents.withInitiator(agent, () =>
        stockEnsure.call(this, agent, signal),
      );
    },
    set(
      this: WorkingDirectoryService,
      agent: Agent,
      path: string,
      signal?: AbortSignal,
    ): Promise<string> {
      return agents.withInitiator(agent, () =>
        stockSet.call(this, agent, path, signal),
      );
    },
  };

  for (const [method, value] of Object.entries(wrappers)) {
    Object.defineProperty(directories, method, {
      configurable: true,
      writable: true,
      value,
    });
  }
  return () => {
    for (const method of Object.keys(wrappers)) {
      Reflect.deleteProperty(directories, method);
    }
  };
}

export const name = "sandbox-working-directory";

/**
 * Wait for the service instead of injecting it, like the other wrapping rows,
 * so the row never holds up boot in a composition without it.
 */
export function apply(ctx: Context): void {
  ctx.inject(["workingDirectory", "agents", "sandboxManager"], (scope) => {
    // `scope.workingDirectory` is a cordis proxy that rebinds `this.ctx` per
    // caller; define the wrappers on the instance behind it.
    const directories =
      (Reflect.get(scope.workingDirectory, symbols.original) as
        | WorkingDirectoryService
        | undefined) ?? scope.workingDirectory;
    scope.effect(() =>
      useSandboxFrame(
        directories,
        scope.agents,
        () => scope.sandboxManager.workspace,
      ),
    );
  });
}
