/**
 * Runs dsh's Web terminal controller against the session's sandbox.
 *
 * `@deepseek-ai/dsh-api-terminal-controller` serves the right sidebar's
 * Terminal tab. Each of its typed Remote methods receives the session owner
 * (`agent`) that the gateway resolved from the wire, and drives the terminal
 * through `ctx.subprocess.spawnTerminal` — which this package implements over
 * the runner's PTY RPC. This bundle's subprocess seam finds a session's
 * sandbox through the agent that is asking (`ctx.agents.requireInitiator()`),
 * the same way `fs`, `shell`, and the one-shot spawn path do, and browser
 * requests arrive outside any agent turn. Without a boundary, opening a
 * terminal fails with "no initiator" exactly as the sidebar's file browser
 * did.
 *
 * The wire already carries the session: every method that reaches the seam
 * takes the resolved Agent first. This module keeps the stock row mounted and
 * wraps the live instance's methods so those calls run inside
 * `agents.withInitiator(agent, ...)`. A request then reaches the sandbox the
 * way a tool call does: a hibernated sandbox wakes, and the allocation counts
 * as activity for the idle timer. Accepted input and resize also reset that
 * timer, so a sandbox is not hibernated out from under a terminal someone is
 * typing in. Nothing starts or wakes on a keystroke: if the sandbox is gone,
 * its terminal is too, and the stock controller marks it failed.
 *
 * The stock row has to stay mounted, under its own name, because its browser
 * half comes with it: the Web app serves a package's client bundle only for a
 * mounted row of that package, and the sidebar's terminal provider lives in
 * that bundle. Replacing the row with a subclass would leave the tab without
 * it. The wrappers are own properties on the service instance, so the stock
 * prototype methods and their remote markers, which the gateway reads, are
 * untouched; disposing the row removes them.
 *
 * @module @zhming0/dsh-yawn/terminal-controller
 */

import { symbols, type Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {
  TerminalController,
  TerminalCreateRequest,
  TerminalFrame,
  WebTerminalId,
} from "@deepseek-ai/dsh-api-terminal-controller";

type SessionAgents = Pick<Context["agents"], "withInitiator">;

/**
 * Wrap the live `terminalController` service so the calls that reach the
 * sandbox run as the session's agent, and so terminal input keeps the sandbox
 * awake. Returns the undo.
 * @param controller - the service instance, with any cordis proxy removed.
 * @param agents - the Agent registry whose initiator scope the seam reads.
 * @param noteActivity - session activity sink for accepted input and resize.
 */
export function scopeToSession(
  controller: TerminalController,
  agents: SessionAgents,
  noteActivity: (agent: Agent) => void,
): () => void {
  const undo: (() => void)[] = [];
  const replace = (method: string, value: unknown): void => {
    Object.defineProperty(controller, method, {
      configurable: true,
      writable: true,
      value,
    });
    undo.push(() => {
      Reflect.deleteProperty(controller, method);
    });
  };

  // Shell discovery resolves executables through the runner; creation
  // allocates the terminal and wakes a hibernated sandbox on the way.
  const stockShells = Reflect.get(controller, "shells");
  replace(
    "shells",
    function (this: TerminalController, agent: Agent, signal: AbortSignal) {
      return agents.withInitiator(agent, () =>
        stockShells.call(this, agent, signal),
      );
    },
  );

  const stockCreate = Reflect.get(controller, "create");
  replace(
    "create",
    function (
      this: TerminalController,
      agent: Agent,
      request: TerminalCreateRequest,
      signal: AbortSignal,
    ) {
      return agents.withInitiator(agent, () =>
        stockCreate.call(this, agent, request, signal),
      );
    },
  );

  // Input and resize are how an open terminal shows use. They arrive on the
  // `attach` stream's uplink, which the stock method reads from its own Remote
  // invocation, and each accepted command is answered with an `ack` frame on
  // the downlink, so an ack without a refusal marks one keystroke or resize
  // that reached the process. The stream is opened synchronously, so a bad id
  // still fails the call itself.
  const stockAttach = Reflect.get(controller, "attach");
  replace(
    "attach",
    function (
      this: TerminalController,
      agent: Agent,
      id: WebTerminalId,
      signal: AbortSignal,
    ) {
      const frames: AsyncIterable<TerminalFrame> = stockAttach.call(
        this,
        agent,
        id,
        signal,
      );
      return noteInput(frames, () => noteActivity(agent));
    },
  );

  return () => {
    for (const restore of undo) {
      restore();
    }
  };
}

/** Pass frames through, calling `onInput` for each accepted input command. */
async function* noteInput(
  frames: AsyncIterable<TerminalFrame>,
  onInput: () => void,
): AsyncGenerator<TerminalFrame> {
  for await (const frame of frames) {
    if (frame.type === "ack" && frame.refusal === undefined) {
      onInput();
    }
    yield frame;
  }
}

export const name = "sandbox-terminal-controller";

/**
 * Wait for the service instead of injecting it: `terminalController` comes
 * with the Web surface only, and dsh refuses to boot over a row whose services
 * never arrive, so waiting inside the row keeps a headless profile bootable.
 */
export function apply(ctx: Context): void {
  ctx.inject(["terminalController", "agents", "sandboxManager"], (scope) => {
    // `scope.terminalController` is a cordis proxy that rebinds `this.ctx`
    // per caller; define the wrappers on the instance behind it.
    const controller =
      (Reflect.get(scope.terminalController, symbols.original) as
        | TerminalController
        | undefined) ?? scope.terminalController;
    scope.effect(() =>
      scopeToSession(controller, scope.agents, (agent) =>
        scope.sandboxManager.noteActivity(agent),
      ),
    );
  });
}
