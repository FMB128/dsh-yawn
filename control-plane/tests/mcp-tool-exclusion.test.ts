import { Context } from "@deepseek-ai/cordis";
import { agentEvents, type Agent } from "@deepseek-ai/dsh-agent";
import { describe, expect, it, vi } from "vitest";

import {
  Config,
  DEFAULT_EXCLUDED_PRESETS,
  McpToolExclusion,
  apply,
  isMcpToolName,
  mcpToolNames,
} from "../src/mcp-tool-exclusion.js";

const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

interface RestrictCall {
  deny: string[];
  dispose: () => void;
}

function makeHarness(
  options: {
    preset?: string | undefined;
    deferInject?: boolean;
    presets?: boolean;
  } = {},
) {
  const ctx = new Context();
  const schemaNames = [
    "bash",
    "read",
    "mcp__buildkite__list_builds",
    "read_mcp_resource",
  ];
  const restrictions: RestrictCall[] = [];
  const tools = {
    schemas: () =>
      schemaNames.map((name) => ({ name, description: "", parameters: {} })),
    restrict: vi.fn((filter: { deny: string[] }) => {
      const call: RestrictCall = {
        deny: [...filter.deny],
        dispose: vi.fn(() => undefined),
      };
      restrictions.push(call);
      return call.dispose;
    }),
  };
  const fiberDisposals: ReturnType<typeof vi.fn>[] = [];
  const pendingInjections: Array<() => void> = [];
  let preset = Object.hasOwn(options, "preset") ? options.preset : "minimal";
  const agent = {
    id: "session-minimal",
    session: {
      id: "session-minimal",
      // The creation fact, deliberately kept apart from the live preset the
      // registry reports: the Web UI picks a preset for a blank session
      // through agentPresets.select, which never rewrites this header.
      header: { agentPreset: "standard" },
    },
    ctx: {
      inject: (_services: string[], callback: (scope: unknown) => void) => {
        let owned: RestrictCall | undefined;
        const scopedTools = {
          ...tools,
          restrict: (filter: { deny: string[] }): (() => void) => {
            const disposer = tools.restrict(filter);
            owned = restrictions[restrictions.length - 1];
            return disposer;
          },
        };
        const run = () => callback({ tools: scopedTools });
        if (options.deferInject === true) {
          pendingInjections.push(run);
        } else {
          run();
        }
        // Cordis tears the injected fiber's restriction effect down with the
        // fiber, so the mock dispose lifts this injection's mask.
        const dispose = vi.fn(() => owned?.dispose());
        fiberDisposals.push(dispose);
        return { dispose };
      },
    },
  } as unknown as Agent;
  const agents = { list: () => [] as Agent[] };
  ctx.provide("agents", agents);
  ctx.provide("tools", tools);
  if (options.presets !== false) {
    ctx.provide("agentPresets", {
      composedPreset: () => preset,
    });
  }
  return {
    agent,
    agents,
    ctx,
    fiberDisposals,
    pendingInjections,
    restrictions,
    schemaNames,
    selectPreset: (next: string | undefined) => {
      preset = next;
    },
    tools,
  };
}

describe("isMcpToolName", () => {
  it("matches server tools and the shared resource tools", () => {
    expect(isMcpToolName("mcp__buildkite__list_builds")).toBe(true);
    expect(isMcpToolName("list_mcp_resources")).toBe(true);
    expect(isMcpToolName("list_mcp_resource_templates")).toBe(true);
    expect(isMcpToolName("read_mcp_resource")).toBe(true);
    expect(isMcpToolName("mcp_resources")).toBe(false);
    expect(isMcpToolName("bash")).toBe(false);
  });
});

describe("mcpToolNames", () => {
  it("keeps only MCP names, sorted", () => {
    expect(
      mcpToolNames([
        "read",
        "mcp__notion__search",
        "bash",
        "mcp__buildkite__list_builds",
        "read_mcp_resource",
      ]),
    ).toEqual([
      "mcp__buildkite__list_builds",
      "mcp__notion__search",
      "read_mcp_resource",
    ]);
  });
});

describe("Config", () => {
  it("defaults the excluded preset list to minimal", () => {
    expect(Config(undefined)).toEqual({
      excludedPresets: [...DEFAULT_EXCLUDED_PRESETS],
    });
    expect(Config({})).toEqual({
      excludedPresets: [...DEFAULT_EXCLUDED_PRESETS],
    });
    expect(Config({ excludedPresets: ["standard"] })).toEqual({
      excludedPresets: ["standard"],
    });
  });
});

describe("apply", () => {
  it("denies MCP tools on a minimal agent and follows registry changes", async () => {
    const harness = makeHarness();
    apply(harness.ctx, { excludedPresets: ["minimal"] });
    await flush();
    agentEvents(harness.ctx, harness.agent).emit("agent/created", {
      source: "startup",
    });

    expect(harness.restrictions.map((call) => call.deny)).toEqual([
      ["mcp__buildkite__list_builds", "read_mcp_resource"],
    ]);

    harness.schemaNames.push("mcp__notion__search");
    harness.ctx.emit("tools/change");
    expect(harness.restrictions.map((call) => call.deny)).toEqual([
      ["mcp__buildkite__list_builds", "read_mcp_resource"],
      [
        "mcp__buildkite__list_builds",
        "mcp__notion__search",
        "read_mcp_resource",
      ],
    ]);
    expect(harness.restrictions[0]?.dispose).toHaveBeenCalledTimes(1);

    harness.schemaNames.length = 0;
    harness.ctx.emit("tools/change");
    expect(harness.restrictions).toHaveLength(2);
    expect(harness.restrictions[1]?.dispose).toHaveBeenCalledTimes(1);
  });

  it("covers agents that already exist when the row mounts", async () => {
    const harness = makeHarness();
    harness.agents.list = () => [harness.agent];
    apply(harness.ctx, { excludedPresets: ["minimal"] });
    await flush();
    expect(harness.restrictions).toHaveLength(1);
  });

  it("leaves other presets alone", async () => {
    const harness = makeHarness({ preset: "standard" });
    apply(harness.ctx, { excludedPresets: ["minimal"] });
    await flush();
    agentEvents(harness.ctx, harness.agent).emit("agent/created", {
      source: "startup",
    });
    expect(harness.restrictions).toHaveLength(0);
  });

  it("does nothing when the agent runs no preset", async () => {
    const harness = makeHarness({ preset: undefined });
    apply(harness.ctx, { excludedPresets: ["minimal"] });
    await flush();
    agentEvents(harness.ctx, harness.agent).emit("agent/created", {
      source: "startup",
    });
    expect(harness.restrictions).toHaveLength(0);
  });

  it("follows a preset selected on a blank session", async () => {
    const harness = makeHarness({ preset: "standard" });
    harness.agents.list = () => [harness.agent];
    apply(harness.ctx, { excludedPresets: ["minimal"] });
    await flush();
    agentEvents(harness.ctx, harness.agent).emit("agent/created", {
      source: "startup",
    });
    expect(harness.restrictions).toHaveLength(0);

    // The Web UI picks `minimal` for the blank session. The preset registry
    // rebinds the composition and emits `tools/change`; the session header
    // keeps naming the preset the session started with.
    harness.selectPreset("minimal");
    harness.ctx.emit("tools/change");
    expect(harness.agent.session.header.agentPreset).toBe("standard");
    expect(harness.restrictions.map((call) => call.deny)).toEqual([
      ["mcp__buildkite__list_builds", "read_mcp_resource"],
    ]);
  });

  it("lifts the restriction when the live preset changes away", async () => {
    const harness = makeHarness();
    harness.agents.list = () => [harness.agent];
    apply(harness.ctx, { excludedPresets: ["minimal"] });
    await flush();
    agentEvents(harness.ctx, harness.agent).emit("agent/created", {
      source: "startup",
    });
    expect(harness.restrictions).toHaveLength(1);

    harness.selectPreset("standard");
    harness.ctx.emit("tools/change");
    expect(harness.fiberDisposals[0]).toHaveBeenCalledTimes(1);
    expect(harness.restrictions[0]?.dispose).toHaveBeenCalledTimes(1);
    harness.ctx.emit("tools/change");
    expect(harness.restrictions).toHaveLength(1);
  });

  it("is inert when no preset registry is mounted", async () => {
    const harness = makeHarness({ preset: "minimal", presets: false });
    harness.agents.list = () => [harness.agent];
    apply(harness.ctx, { excludedPresets: ["minimal"] });
    await flush();
    agentEvents(harness.ctx, harness.agent).emit("agent/created", {
      source: "startup",
    });
    harness.ctx.emit("tools/change");
    expect(harness.restrictions).toHaveLength(0);
  });

  it("keeps the previous mask when a new restrict fails", async () => {
    const harness = makeHarness();
    apply(harness.ctx, { excludedPresets: ["minimal"] });
    await flush();
    agentEvents(harness.ctx, harness.agent).emit("agent/created", {
      source: "startup",
    });
    expect(harness.restrictions).toHaveLength(1);

    harness.schemaNames.push("mcp__notion__search");
    harness.tools.restrict.mockImplementationOnce(() => {
      throw new Error("unknown global tool");
    });
    harness.ctx.emit("tools/change");
    expect(harness.restrictions).toHaveLength(1);
    expect(harness.restrictions[0]?.dispose).not.toHaveBeenCalled();

    harness.ctx.emit("tools/change");
    expect(harness.restrictions).toHaveLength(2);
    expect(harness.restrictions[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it("is inert for an empty excluded list", async () => {
    const harness = makeHarness();
    apply(harness.ctx, { excludedPresets: [] });
    await flush();
    agentEvents(harness.ctx, harness.agent).emit("agent/created", {
      source: "startup",
    });
    expect(harness.restrictions).toHaveLength(0);
  });

  it("does not restrict an agent disposed before its tools scope is live", async () => {
    const harness = makeHarness({ deferInject: true });
    apply(harness.ctx, { excludedPresets: ["minimal"] });
    await flush();
    agentEvents(harness.ctx, harness.agent).emit("agent/created", {
      source: "startup",
    });
    expect(harness.fiberDisposals[0]).not.toHaveBeenCalled();

    agentEvents(harness.ctx, harness.agent).emit("agent/disposed", {});
    expect(harness.fiberDisposals[0]).toHaveBeenCalledTimes(1);
    for (const run of harness.pendingInjections.splice(0)) {
      run();
    }
    expect(harness.restrictions).toHaveLength(0);
  });

  it("drops one agent's policy when it is disposed", async () => {
    const harness = makeHarness();
    apply(harness.ctx, { excludedPresets: ["minimal"] });
    await flush();
    agentEvents(harness.ctx, harness.agent).emit("agent/created", {
      source: "startup",
    });
    agentEvents(harness.ctx, harness.agent).emit("agent/disposed", {});
    expect(harness.fiberDisposals[0]).toHaveBeenCalledTimes(1);

    harness.ctx.emit("tools/change");
    expect(harness.restrictions).toHaveLength(1);
  });
});

describe("McpToolExclusion.dispose", () => {
  it("ignores registry changes and syncs after disposal", () => {
    const harness = makeHarness();
    harness.agents.list = () => [harness.agent];
    const exclusion = new McpToolExclusion({
      excludedPresets: ["minimal"],
      presetFor: () => "minimal",
      agents: () => harness.agents.list(),
      toolNames: () => harness.schemaNames,
      warn: () => undefined,
    });
    exclusion.sync(harness.agent);
    expect(harness.restrictions).toHaveLength(1);

    exclusion.dispose();
    exclusion.reconcile();
    exclusion.sync(harness.agent);
    expect(harness.restrictions).toHaveLength(1);
  });
});
