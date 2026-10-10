/**
 * Sandbox truth for the model-facing system prompt.
 *
 * Sandboxed sessions work entirely in sandbox paths, but dsh's prompt
 * variables describe the host: `cwd` is a bookkeeping anchor that does not
 * exist inside the sandbox. This module:
 *
 * 1. shadows the `cwd` prompt variable with the sandbox workspace, so any
 *    prompt text that renders it names a path the model's tools actually
 *    resolve (dsh's own "Current working directory" line does not use the
 *    variable; `working-directory.ts` keeps that one in sandbox paths); and
 * 2. contributes a short environment section stating where tools run.
 *
 * dsh's host-only prompt text — the implementation checkout and the Web GUI
 * URL — comes from its `harness-dev-context` row, which the bundle patch
 * disables, so there is nothing here to remove.
 *
 * @module @zhming0/dsh-yawn/sandbox-context
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";

import { artifactsDirectory } from "./artifacts.js";
import type { BackendCapabilities } from "./types.js";

/** Name of the environment section this module contributes. */
export const SANDBOX_ENVIRONMENT_SECTION = "environment:sandbox";

/**
 * The sentences both environment sections share. One carries the "this page
 * means the GUI" mapping from the Web GUI paragraph of dsh's disabled
 * `harness-dev-context` row: that mapping stays true for a sandboxed session
 * even though the GUI URL is unreachable from it.
 */
const HOST_SENTENCES =
  'There is no DeepSeek Harness source checkout inside the sandbox; the DeepSeek Harness web UI runs on the host machine and is unreachable from here. When the user says "this page", "this GUI", or "this app", they mean that web UI. {{preview}}';

/**
 * What the model can install: sudo works, so system packages are reachable,
 * but they live outside $HOME and go away with the machine, so project tools
 * belong to mise, uv, or npm instead. `{{tool_retention}}` says what this
 * backend keeps of them across a sleep.
 */
const TOOL_SENTENCES =
  "The sandbox user has passwordless sudo, so system package managers can install software, but what you install yourself outside $HOME lasts only as long as this machine. Prefer the preinstalled managers for project tools: `mise use -g` for toolchains, `uv tool install` for Python tools, and `npm install -g` for Node tools. Those write under $HOME. {{tool_retention}}";

/**
 * The environment section text. `{{cwd}}` renders the sandbox workspace
 * through the shadowed prompt variable and `{{artifacts}}` the durable output
 * folder beside it. One sentence states the wake rule: a sleep that rebuilds
 * the machine starts it with what is under /workspace and runs the
 * repository's setup hook, `.agents/setup`, again, so the model does not
 * re-install what the repository declares and knows where to look for what it
 * installs. The last states the one rule for output that must outlive the
 * sandbox: put it in the artifacts folder, because everything else outside the
 * checkout is disposable. The checkpoint transfer cap is deliberately absent:
 * it exists only on a backend that checkpoints, so the checkpoint docs and the
 * restore notice carry it.
 */
export const SANDBOX_ENVIRONMENT_PROMPT = [
  "You are working inside an isolated sandbox: file and shell tools resolve paths inside this sandbox, and the repository checkout is mounted at {{cwd}}.",
  HOST_SENTENCES,
  "When a sleep rebuilds the machine, the new machine starts with what is under /workspace and the repository's setup hook, `.agents/setup`, runs again on it, so what the repository installs is back.",
  TOOL_SENTENCES,
  "Anything the user should keep but that does not belong in the repository — screenshots, recordings, reports — goes in {{artifacts}}, which always comes back.",
].join(" ");

/**
 * The environment section for a session in the Scratch Workspace, which has
 * no repository: the working directory starts empty and nothing is said about
 * a checkout or a setup hook. `{{workdir_retention}}` states what a sleep
 * keeps of the working directory; on a backend that checkpoints, that is
 * nothing, because without a remote to diff against the checkpoint would have
 * to carry the whole directory. The artifacts rule is the same as above.
 */
export const NO_REPOSITORY_ENVIRONMENT_PROMPT = [
  "You are working inside an isolated sandbox: file and shell tools resolve paths inside this sandbox, and your working directory, {{cwd}}, started empty.",
  HOST_SENTENCES,
  "{{workdir_retention}}",
  TOOL_SENTENCES,
  "Anything the user should keep — screenshots, recordings, reports — goes in {{artifacts}}, which always comes back.",
].join(" ");

/**
 * What a session without a repository is told a sleep keeps of its working
 * directory, decided by the backend capabilities like `toolRetention`.
 */
function workdirRetention(
  capabilities: BackendCapabilities | undefined,
): string {
  if (capabilities === undefined) {
    return "A sleep may not keep your working directory.";
  }
  if (!capabilities.supportsHibernate) {
    return "A sleep replaces this machine and does not keep your working directory.";
  }
  return capabilities.wakeKeepsFilesystem === true
    ? "A sleep keeps your working directory: this sandbox stops and comes back with its files."
    : "When a sleep rebuilds the machine, the new machine starts with what is under /workspace, your working directory included.";
}

/**
 * What the model is told about tools it installs under $HOME. The backend
 * capabilities decide it, so a session is not told its tools may vanish on a
 * backend that keeps them, or that they stay on one that rebuilds the
 * machine. The mechanisms behind the answer stay out of the prompt.
 */
function toolRetention(capabilities: BackendCapabilities | undefined): string {
  if (capabilities === undefined) {
    return "A sleep may not keep them, so reinstall what you need.";
  }
  if (!capabilities.supportsHibernate) {
    return "A sleep does not keep them, so reinstall what you need.";
  }
  return capabilities.wakeKeepsFilesystem === true
    ? "A sleep keeps them: this sandbox stops and comes back with its files."
    : "A sleep keeps them: files under /workspace come back with the new machine.";
}

/** The systemPrompt surface this module needs, structural for testing. */
interface SystemPromptLike {
  getSectionOrder(name: string): number;
  section(section: { name: string; order: number; text: string }): unknown;
  variable(
    name: string,
    provider: (context: unknown) => string | undefined,
  ): unknown;
}

/**
 * Register the environment section and its variables on one agent's system
 * prompt scope: the sandbox `cwd` (shadowing the loop-supplied host cwd), the
 * artifacts folder beside it, and what this backend keeps across a sleep. The
 * providers resolve on each assembly, so a profile chosen after the agent
 * exists is reflected. The section text is fixed here: whether the session
 * has a repository follows from its cwd, which never changes.
 */
export function installSandboxContext(
  systemPrompt: SystemPromptLike,
  workspace: () => string,
  capabilities: () => BackendCapabilities | undefined,
  previewOrigin: () => string | undefined,
  withRepository = true,
): void {
  systemPrompt.section({
    name: SANDBOX_ENVIRONMENT_SECTION,
    order: systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX"),
    text: withRepository
      ? SANDBOX_ENVIRONMENT_PROMPT
      : NO_REPOSITORY_ENVIRONMENT_PROMPT,
  });
  systemPrompt.variable("cwd", () => workspace());
  systemPrompt.variable("artifacts", () => artifactsDirectory(workspace()));
  systemPrompt.variable("tool_retention", () => toolRetention(capabilities()));
  if (!withRepository) {
    systemPrompt.variable("workdir_retention", () =>
      workdirRetention(capabilities()),
    );
  }
  systemPrompt.variable("preview", () => previewSentence(previewOrigin()));
}

/**
 * The previews sentence, expanded per assembly. Without an origin — previews
 * unconfigured, or no sandbox yet — it is empty, so the prompt never promises
 * an address it cannot name.
 */
function previewSentence(origin: string | undefined): string {
  if (origin === undefined) {
    return "";
  }
  return `HTTP servers you leave running on a sandbox port are served to the user's browser at ${origin}, with PORT replaced by the port the server listens on: start such servers detached so they outlive the command, and give the user that address to open.`;
}

export const name = "sandbox-context";
export const inject = ["sandboxManager", "agents"];

export function apply(ctx: Context): void {
  const promptFibers = new Map<Agent, ReturnType<Context["inject"]>>();
  const promptDisposals = new Set<Promise<void>>();
  const installPrompt = (agent: Agent): void => {
    if (promptFibers.has(agent)) {
      return;
    }
    const fiber = agent.ctx.inject(["systemPrompt"], (scope) => {
      installSandboxContext(
        scope.systemPrompt,
        () => ctx.sandboxManager.workspace,
        () => ctx.sandboxManager.sandboxCapabilitiesFor(agent),
        () => ctx.sandboxManager.previewOriginFor(agent),
        !ctx.sandboxManager.inScratchWorkspace(agent),
      );
    });
    promptFibers.set(agent, fiber);
  };
  const disposePrompt = (agent: Agent): void => {
    const fiber = promptFibers.get(agent);
    if (fiber === undefined) {
      return;
    }
    promptFibers.delete(agent);
    const task = fiber.dispose().catch((error: unknown) => {
      ctx.logger.warn(
        `sandbox-context: prompt cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    promptDisposals.add(task);
    void task.finally(() => {
      promptDisposals.delete(task);
    });
  };
  for (const agent of ctx.agents.list()) {
    installPrompt(agent);
  }
  ctx.on("agent/created", ({ agent }) => {
    installPrompt(agent);
    return undefined;
  });
  ctx.on("agent/disposed", ({ agent }) => {
    disposePrompt(agent);
  });
  ctx.effect(
    () => async () => {
      const fibers = [...promptFibers.values()];
      promptFibers.clear();
      await Promise.all([
        ...fibers.map((fiber) => fiber.dispose()),
        ...promptDisposals,
      ]);
    },
    "sandbox-context: disposal",
  );
}
