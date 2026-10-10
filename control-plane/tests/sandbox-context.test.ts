import { Context } from "@deepseek-ai/cordis";
import { SystemPrompt, renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import { describe, expect, it } from "vitest";

import {
  NO_REPOSITORY_ENVIRONMENT_PROMPT,
  SANDBOX_ENVIRONMENT_PROMPT,
  SANDBOX_ENVIRONMENT_SECTION,
  installSandboxContext,
} from "../src/sandbox-context.js";
import type { BackendCapabilities } from "../src/types.js";

/** A recording systemPrompt stub. */
function makeSystemPromptStub() {
  const sections: Array<{ name: string; order: number; text: string }> = [];
  const variables = new Map<string, (context: unknown) => string | undefined>();
  return {
    sections,
    variables,
    getSectionOrder: () => 0,
    section(section: { name: string; order: number; text: string }) {
      sections.push(section);
    },
    variable(name: string, provider: (context: unknown) => string | undefined) {
      variables.set(name, provider);
    },
  };
}

describe("installSandboxContext", () => {
  it("names the preview address once the sandbox has one", () => {
    const systemPrompt = makeSystemPromptStub();
    installSandboxContext(
      systemPrompt,
      () => "/workspace/repository",
      () => undefined,
      () => "https://sandbox-one-pPORT.sandbox.example.com/",
    );
    expect(systemPrompt.variables.get("preview")?.({})).toBe(
      "HTTP servers you leave running on a sandbox port are served to the user's browser at https://sandbox-one-pPORT.sandbox.example.com/, with PORT replaced by the port the server listens on: start such servers detached so they outlive the command, and give the user that address to open.",
    );
  });

  it("registers the environment section and the sandbox variables", () => {
    const systemPrompt = makeSystemPromptStub();
    installSandboxContext(
      systemPrompt,
      () => "/workspace/repository",
      () => undefined,
      () => undefined,
    );
    expect(systemPrompt.variables.get("preview")?.({})).toBe("");
    expect(systemPrompt.sections).toEqual([
      {
        name: SANDBOX_ENVIRONMENT_SECTION,
        order: 0,
        text: SANDBOX_ENVIRONMENT_PROMPT,
      },
    ]);
    expect(systemPrompt.variables.get("cwd")?.({})).toBe(
      "/workspace/repository",
    );
    expect(systemPrompt.variables.get("artifacts")?.({})).toBe(
      "/workspace/artifacts",
    );
  });

  it("resolves the workspace lazily on each assembly", () => {
    const systemPrompt = makeSystemPromptStub();
    let workspace = "/workspace/one";
    installSandboxContext(
      systemPrompt,
      () => workspace,
      () => undefined,
      () => undefined,
    );
    expect(systemPrompt.variables.get("cwd")?.({})).toBe("/workspace/one");
    expect(systemPrompt.variables.get("artifacts")?.({})).toBe(
      "/workspace/artifacts",
    );
    workspace = "/workspace/two";
    expect(systemPrompt.variables.get("cwd")?.({})).toBe("/workspace/two");
  });

  it("resolves both sandbox paths from one workspace", () => {
    const systemPrompt = makeSystemPromptStub();
    installSandboxContext(
      systemPrompt,
      () => "/host/checkout",
      () => undefined,
      () => "https://sandbox-one-pPORT.sandbox.example.com/",
    );
    expect(systemPrompt.variables.get("cwd")?.({})).toBe("/host/checkout");
    expect(systemPrompt.variables.get("artifacts")?.({})).toBe(
      "/host/artifacts",
    );
  });

  it("references the workspace variables from the section text", () => {
    expect(SANDBOX_ENVIRONMENT_PROMPT).toContain("{{cwd}}");
    expect(SANDBOX_ENVIRONMENT_PROMPT).toContain("{{artifacts}}");
    expect(SANDBOX_ENVIRONMENT_PROMPT).toContain("{{preview}}");
  });

  it("carries the GUI paragraph's still-true this-page mapping", () => {
    expect(SANDBOX_ENVIRONMENT_PROMPT).toContain('"this page"');
  });

  it("tells the model how to install tools, and that sudo is available", () => {
    expect(SANDBOX_ENVIRONMENT_PROMPT).toContain("passwordless sudo");
    expect(SANDBOX_ENVIRONMENT_PROMPT).toContain("outside $HOME");
    expect(SANDBOX_ENVIRONMENT_PROMPT).toContain("mise use -g");
    expect(SANDBOX_ENVIRONMENT_PROMPT).toContain("uv tool install");
    expect(SANDBOX_ENVIRONMENT_PROMPT).toContain("npm install -g");
    expect(SANDBOX_ENVIRONMENT_PROMPT).toContain("{{tool_retention}}");
  });

  it("states the wake rule", () => {
    expect(SANDBOX_ENVIRONMENT_PROMPT).toContain("`.agents/setup`");
    expect(SANDBOX_ENVIRONMENT_PROMPT).toContain("runs again");
    expect(SANDBOX_ENVIRONMENT_PROMPT).toContain("under /workspace");
  });

  it("tells the model what this backend keeps across a sleep", () => {
    const retention = (capabilities: BackendCapabilities | undefined) => {
      const systemPrompt = makeSystemPromptStub();
      installSandboxContext(
        systemPrompt,
        () => "/workspace/repository",
        () => capabilities,
        () => undefined,
      );
      return systemPrompt.variables.get("tool_retention")?.({});
    };
    expect(retention(undefined)).toContain("may not keep");
    expect(retention({ supportsHibernate: false })).toContain("does not keep");
    expect(
      retention({ supportsHibernate: true, wakeKeepsFilesystem: true }),
    ).toContain("comes back with its files");
    expect(
      retention({ supportsHibernate: true, wakeKeepsFilesystem: false }),
    ).toContain("come back with the new machine");
  });

  it("sends output that must outlive the sandbox to the artifacts folder", () => {
    expect(SANDBOX_ENVIRONMENT_PROMPT).toContain("always comes back");
  });

  it("describes a session without a repository without naming a checkout", () => {
    const install = (capabilities: BackendCapabilities | undefined) => {
      const systemPrompt = makeSystemPromptStub();
      installSandboxContext(
        systemPrompt,
        () => "/workspace/repository",
        () => capabilities,
        () => undefined,
        false,
      );
      return systemPrompt;
    };
    expect(install(undefined).sections).toEqual([
      {
        name: SANDBOX_ENVIRONMENT_SECTION,
        order: 0,
        text: NO_REPOSITORY_ENVIRONMENT_PROMPT,
      },
    ]);
    expect(NO_REPOSITORY_ENVIRONMENT_PROMPT).not.toMatch(
      /repository|checkout is mounted|\.agents\/setup/,
    );
    expect(NO_REPOSITORY_ENVIRONMENT_PROMPT).toContain("started empty");
    expect(NO_REPOSITORY_ENVIRONMENT_PROMPT).toContain("always comes back");

    const retention = (capabilities: BackendCapabilities | undefined) =>
      install(capabilities).variables.get("workdir_retention")?.({});
    expect(retention(undefined)).toContain("may not keep");
    expect(retention({ supportsHibernate: false })).toBe(
      "A sleep replaces this machine and does not keep your working directory.",
    );
    expect(
      retention({ supportsHibernate: true, wakeKeepsFilesystem: true }),
    ).toContain("comes back with its files");
    expect(
      retention({ supportsHibernate: true, wakeKeepsFilesystem: false }),
    ).toContain("your working directory included");
  });
});

describe("against the pinned dsh-system-prompt service", () => {
  it("resolves the sandbox variables in a real assembly", async () => {
    const ctx = new Context();
    const systemPrompt = new SystemPrompt(ctx, {
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
    });
    installSandboxContext(
      systemPrompt,
      () => "/workspace/repository",
      () => ({ supportsHibernate: false }),
      () => "https://sandbox-one-pPORT.sandbox.example.com/",
    );

    const assembly = await systemPrompt.assemble({});
    const rendered = renderPrompt(assembly);
    expect(rendered).toContain("/workspace/artifacts");
    expect(rendered).toContain(
      "HTTP servers you leave running on a sandbox port are served to the user's browser at https://sandbox-one-pPORT.sandbox.example.com/",
    );
    expect(rendered).toContain(
      "A sleep does not keep them, so reinstall what you need.",
    );
  });
});
