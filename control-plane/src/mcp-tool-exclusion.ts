/**
 * Keeps MCP tools out of the agent presets that are meant to stay tiny.
 *
 * The control plane mounts every configured MCP server once, at the host
 * root, so its tools join the global tool registry and every agent inherits
 * them. That is deliberate: one connection, one OAuth renewal, one namespace
 * per server. It also means the `minimal` preset — whose whole composition is
 * a persona and one persistent shell — would otherwise carry the full schema
 * of every connected server, exactly the cost it exists to avoid.
 *
 * Upstream has no special case for this either: `dsh-mcp-client` registers
 * its tools in the scope where the row is mounted, so a profile that mounts it
 * inside `preset-minimal` simply has no MCP tools there. This deployment
 * cannot use that shape because servers are added and removed at runtime from
 * the Web UI and share one connection across sessions.
 *
 * This row keeps the shared mount and denies MCP tools on the agents whose
 * live composition is one of the configured presets instead. The live preset
 * comes from the agent-preset registry, not the session header: the header
 * records only the preset a session STARTED with, while the Web UI picks a
 * preset for a blank session through `agentPresets.select`, which rebinds the
 * agent's composition — for example from `standard` to `minimal` — and
 * appends the durable `agent-preset/selected` event without rewriting that
 * creation fact. The registry emits `tools/change` when `select` moves a
 * blank session to another preset, so every live agent's preset is re-read
 * there and the exact-name deny list is recomputed on every registry change;
 * the deny list must also follow server add/remove, reconnect, and tool-list
 * updates for the same reason. A fresh session's first mount emits no such
 * event, so `agent/created` covers it.
 * The default preset list holds `minimal`, whose persona declares `complete`:
 * the assembly drops every prompt section, so no MCP prompt text reaches it
 * either, and hiding the tool schemas is the whole policy there.
 *
 * @module @zhming0/dsh-yawn/mcp-tool-exclusion
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";

/** Presets excluded unless the row config names another list. */
export const DEFAULT_EXCLUDED_PRESETS = ["minimal"] as const;

export interface Config {
  /**
   * Agent preset ids that must not see MCP tools. The default is the stock
   * shell-only preset; an empty list disables the row.
   */
  excludedPresets: string[];
}

export const Config = z.object({
  excludedPresets: z.array(z.string()).default([...DEFAULT_EXCLUDED_PRESETS]),
}) as z<Partial<Config>, Config>;

/**
 * dsh-mcp-resources' three shared tools. A configured server registers them
 * in the caller's scope beside the `mcp__*` server tools; this deployment
 * mounts servers at the host root, so all of them live in the global registry.
 */
const MCP_RESOURCE_TOOL_NAMES = new Set([
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
]);

/** Whether one tool name belongs to an MCP server or the shared resource tools. */
export function isMcpToolName(name: string): boolean {
  return name.startsWith("mcp__") || MCP_RESOURCE_TOOL_NAMES.has(name);
}

/** The MCP names in one list of registered tool names, sorted. */
export function mcpToolNames(names: readonly string[]): string[] {
  return names.filter(isMcpToolName).sort();
}

/**
 * The live-preset read face of the agent-preset registry. Only the Web
 * surface mounts the registry; a profile without it composes no presets, so
 * every agent runs the host composition and nothing is excluded.
 */
interface AgentPresetsLike {
  /** Read the preset a live agent runs, or undefined when it runs none. */
  composedPreset(ctx: Context): string | undefined;
}

/** The part of a Cordis fiber this module owns. */
interface FiberLike {
  dispose(): unknown;
}

/** One excluded agent's live restriction. */
interface AgentPolicy {
  fiber: FiberLike;
  /** Set before a disposed agent's injected scope callback can still run. */
  disposed?: boolean | undefined;
  /** Set once the agent's injected tools scope is live. */
  update?: ((names: readonly string[]) => void) | undefined;
  /** The exact disposer that lifts the current restriction. */
  restriction?: (() => void) | undefined;
  /** The names currently denied; undefined until the first update. */
  names?: readonly string[] | undefined;
}

function sameNames(
  left: readonly string[] | undefined,
  right: readonly string[],
): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((name, index) => name === right[index])
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Applies the exclusion to the matching agents and tracks it until disposal. */
export class McpToolExclusion {
  private readonly agents = new Map<Agent, AgentPolicy>();
  private readonly excluded: Set<string>;
  private disposed = false;
  private reconciling = false;
  private recheck = false;

  constructor(
    private readonly options: {
      excludedPresets: readonly string[];
      /** The live preset of one agent, undefined when it runs none. */
      presetFor: (agent: Agent) => string | undefined;
      /** Every live agent, so registry changes re-read each live preset. */
      agents: () => readonly Agent[];
      /** Every name in the global tool registry, MCP or not. */
      toolNames: () => readonly string[];
      warn: (message: string) => void;
    },
  ) {
    this.excluded = new Set(options.excludedPresets);
  }

  /** Whether one agent's live preset is currently excluded. */
  private isExcluded(agent: Agent): boolean {
    if (this.excluded.size === 0) {
      return false;
    }
    const preset = this.options.presetFor(agent);
    return preset !== undefined && this.excluded.has(preset);
  }

  /** Apply or lift the restriction for one agent's live preset. */
  sync(agent: Agent): void {
    if (this.disposed) {
      return;
    }
    if (this.isExcluded(agent)) {
      this.install(agent);
    } else {
      this.remove(agent);
    }
  }

  /** Start hiding MCP tools from one agent when its preset is excluded. */
  install(agent: Agent): void {
    if (this.disposed || this.agents.has(agent) || !this.isExcluded(agent)) {
      return;
    }
    const policy: AgentPolicy = {
      fiber: { dispose: () => undefined },
    };
    this.agents.set(agent, policy);
    try {
      policy.fiber = agent.ctx.inject(["tools"], (scope) => {
        if (policy.disposed === true) {
          return;
        }
        policy.update = (names) => {
          if (sameNames(policy.names, names)) {
            return;
          }
          // Install the new mask before lifting the old one, so a failed
          // restrict leaves the previous mask in place and retries on the
          // next registry change.
          let next: (() => void) | undefined;
          if (names.length > 0) {
            try {
              next = scope.tools.restrict({ deny: [...names] });
            } catch (error) {
              this.options.warn(
                `mcp-tool-exclusion: could not hide MCP tools from agent ${agent.id}: ${describe(error)}`,
              );
              return;
            }
          }
          const previous = policy.restriction;
          policy.restriction = next;
          policy.names = names;
          previous?.();
        };
        policy.update(mcpToolNames(this.options.toolNames()));
      });
    } catch (error) {
      this.agents.delete(agent);
      this.options.warn(
        `mcp-tool-exclusion: could not watch agent ${agent.id}: ${describe(error)}`,
      );
      return;
    }
  }

  /** Drop one disposed agent's policy. */
  remove(agent: Agent): void {
    const policy = this.agents.get(agent);
    if (policy === undefined) {
      return;
    }
    this.agents.delete(agent);
    policy.disposed = true;
    try {
      void Promise.resolve(policy.fiber.dispose()).catch((error: unknown) => {
        this.options.warn(
          `mcp-tool-exclusion: could not release agent ${agent.id}: ${describe(error)}`,
        );
      });
    } catch (error) {
      this.options.warn(
        `mcp-tool-exclusion: could not release agent ${agent.id}: ${describe(error)}`,
      );
    }
  }

  /** Reapply the policy after any tool- or preset-registry change. */
  reconcile(): void {
    if (this.disposed) {
      return;
    }
    if (this.reconciling) {
      this.recheck = true;
      return;
    }
    this.reconciling = true;
    try {
      do {
        this.recheck = false;
        for (const agent of this.options.agents()) {
          this.sync(agent);
        }
        const names = mcpToolNames(this.options.toolNames());
        for (const policy of this.agents.values()) {
          policy.update?.(names);
        }
      } while (this.recheck);
    } finally {
      this.reconciling = false;
    }
  }

  /**
   * Drop every policy, e.g. when the row unloads. Lifting a mask emits
   * `tools/change`, and Cordis unwinds the row's own effect before its
   * listeners, so the flag must be set before the first fiber goes down.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const agent of [...this.agents.keys()]) {
      this.remove(agent);
    }
  }
}

export const name = "mcp-tool-exclusion";

export function apply(ctx: Context, config: Config): void {
  ctx.inject(["agents", "tools"], (scope) => {
    const exclusion = new McpToolExclusion({
      excludedPresets: config.excludedPresets,
      presetFor: (agent) => {
        const presets = scope.get("agentPresets") as
          | AgentPresetsLike
          | undefined;
        return presets?.composedPreset(agent.ctx);
      },
      agents: () => scope.agents.list(),
      toolNames: () => scope.tools.schemas().map((schema) => schema.name),
      warn: (message) => ctx.logger("mcp-tool-exclusion").warn(message),
    });
    // Covers agents that already exist when the row mounts; a later
    // `tools/change` covers a preset rebound on a blank session.
    exclusion.reconcile();
    scope.on("agent/created", ({ agent }) => {
      exclusion.sync(agent);
      return undefined;
    });
    scope.on("agent/disposed", ({ agent }) => exclusion.remove(agent));
    scope.on("tools/change", () => exclusion.reconcile());
    scope.effect(() => () => exclusion.dispose());
  });
}
