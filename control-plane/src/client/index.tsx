import type { Context } from "@deepseek-ai/cordis";
// These type-only imports load the declaration merges that put `remote`,
// `sessions`, and `slots` on the browser Context, the settings wire types, and
// the `remote.settings` namespace itself.
import type { SettingsPathOpView } from "@deepseek-ai/dsh-api-remotes/client";
import type {} from "@deepseek-ai/dsh-api-session-controller/client";
import type {} from "@deepseek-ai/dsh-api-settings-controller/remote";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";

import type { McpServerEntry } from "../mcp-store.js";
import { yawnRemote } from "../remote-contributions.js";
import { InstructionsSettings } from "./instructions.js";
import { McpSettings } from "./mcp.js";
import { NotificationsSettings } from "./notification-settings.js";
import {
  installTurnNotifications,
  type ClientSessions,
} from "./notifications.js";
import { SandboxProfileChip } from "./profile.js";
import { RepositoryDirectoryFlow } from "./repository-directory-flow.js";
import { SandboxStatusTab } from "./sandbox.js";
import { GitCredentialsSettings } from "./git-credentials.js";
import { SandboxesSettings } from "./settings.js";
import { SecretsSettings } from "./secrets.js";
import { installMediaSession } from "./media-session.js";

/**
 * The client bundle entry: mounts the Remote endpoints and registers the
 * bundle's UI contributions into the dsh Web slots. The contributed views
 * themselves live next to this file, one module per feature.
 */
export const inject = ["remote", "slots"];

/** Mount the Remote endpoints, replace folder picking with repository entry,
 * add the Instructions, Secrets, Git credentials, Sandboxes, MCP, and
 * Notifications sections to the Settings page, and show a browser notification
 * when a turn finishes. */
export async function apply(ctx: Context) {
  const disposeRemote = await ctx.remote.$mount(yawnRemote);

  const unwrap = <T,>(result: RemoteResult<T>): T => {
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.value;
  };

  ctx.inject(["remote.sandboxManager"], (remoteCtx) => {
    const injectedSecrets = () => ({
      getSecrets: async () =>
        unwrap(await remoteCtx.remote.sandboxManager.getSecrets()),
      setGlobalSecret: async (name: string, value: string) =>
        unwrap(
          await remoteCtx.remote.sandboxManager.setGlobalSecret(name, value),
        ),
      setWorkspaceSecret: async (
        repositoryUrl: string,
        name: string,
        value: string,
      ) =>
        unwrap(
          await remoteCtx.remote.sandboxManager.setWorkspaceSecret(
            repositoryUrl,
            name,
            value,
          ),
        ),
      deleteGlobalSecret: async (name: string) =>
        unwrap(await remoteCtx.remote.sandboxManager.deleteGlobalSecret(name)),
      deleteWorkspaceSecret: async (repositoryUrl: string, name: string) =>
        unwrap(
          await remoteCtx.remote.sandboxManager.deleteWorkspaceSecret(
            repositoryUrl,
            name,
          ),
        ),
      setGitHost: async (host: string, username: string, secret: string) =>
        unwrap(
          await remoteCtx.remote.sandboxManager.setGitHost(
            host,
            username,
            secret,
          ),
        ),
      deleteGitHost: async (host: string) =>
        unwrap(await remoteCtx.remote.sandboxManager.deleteGitHost(host)),
    });
    const injectedInstructions = () => ({
      getInstructions: async () =>
        unwrap(await remoteCtx.remote.sandboxManager.getInstructions()),
      setGlobalInstructions: async (content: string) =>
        unwrap(
          await remoteCtx.remote.sandboxManager.setGlobalInstructions(content),
        ),
      setWorkspaceInstructions: async (
        repositoryUrl: string,
        content: string,
      ) =>
        unwrap(
          await remoteCtx.remote.sandboxManager.setWorkspaceInstructions(
            repositoryUrl,
            content,
          ),
        ),
    });
    const injectedMcp = () => ({
      listMcpServers: async () =>
        unwrap(await remoteCtx.remote.sandboxManager.listMcpServers()),
      setMcpServer: async (entry: McpServerEntry) =>
        unwrap(await remoteCtx.remote.sandboxManager.setMcpServer(entry)),
      deleteMcpServer: async (serverName: string) =>
        unwrap(
          await remoteCtx.remote.sandboxManager.deleteMcpServer(serverName),
        ),
      retryMcpServer: async (serverName: string) =>
        unwrap(
          await remoteCtx.remote.sandboxManager.retryMcpServer(serverName),
        ),
      testMcpServer: async (entry: McpServerEntry) =>
        unwrap(await remoteCtx.remote.sandboxManager.testMcpServer(entry)),
      startMcpAuthorization: async (serverName: string, origin: string) =>
        unwrap(
          await remoteCtx.remote.sandboxManager.startMcpAuthorization(
            serverName,
            origin,
          ),
        ),
    });
    remoteCtx.slots.inject(
      "settings.section",
      function* registerSettingsSections() {
        yield remoteCtx.slots.register(
          {
            name: "settings.section",
            id: "dsh-yawn.instructions",
            order: 30,
            label: "Instructions",
            inject: injectedInstructions,
          },
          InstructionsSettings,
        );
        yield remoteCtx.slots.register(
          {
            name: "settings.section",
            id: "dsh-yawn.secrets",
            order: 31,
            label: "Secrets",
            inject: injectedSecrets,
          },
          SecretsSettings,
        );
        yield remoteCtx.slots.register(
          {
            name: "settings.section",
            id: "dsh-yawn.git-credentials",
            order: 33,
            label: "Git credentials",
            inject: injectedSecrets,
          },
          GitCredentialsSettings,
        );
        yield remoteCtx.slots.register(
          {
            name: "settings.section",
            id: "dsh-yawn.mcp",
            order: 35,
            label: "MCP",
            inject: injectedMcp,
          },
          McpSettings,
        );
      },
    );
    const injectedProfile = () => ({
      getSessionProfile: async (sessionId: string) =>
        unwrap(
          await remoteCtx.remote.sandboxManager.getSessionProfile(sessionId),
        ),
      setSessionProfile: async (sessionId: string, profile: string) =>
        unwrap(
          await remoteCtx.remote.sandboxManager.setSessionProfile(
            sessionId,
            profile,
          ),
        ),
    });
    remoteCtx.slots.inject(
      "conversation.input.left",
      function* registerProfileChip() {
        yield remoteCtx.slots.register(
          {
            name: "conversation.input.left",
            id: "dsh-yawn.profile",
            inject: injectedProfile,
          },
          SandboxProfileChip,
        );
      },
    );
    const injectedStatus = () => ({
      getSandboxStatus: async (sessionId: string) =>
        unwrap(
          await remoteCtx.remote.sandboxManager.getSandboxStatus(sessionId),
        ),
    });
    remoteCtx.slots.inject(
      "conversation.view",
      function* registerSandboxView() {
        yield remoteCtx.slots.register(
          {
            name: "conversation.view",
            id: "dsh-yawn.sandbox",
            // After Chat (0) and Trajectory (10).
            order: 20,
            label: () => "Sandbox",
            inject: (sessionId) => ({
              sessionId,
              ...injectedStatus(),
            }),
          },
          SandboxStatusTab,
        );
      },
    );
  });

  ctx.inject(["remote.sandboxManager"], (remoteCtx) => {
    const createWorkspaceAnchor = async (repositoryUrl: string) => {
      const result =
        await remoteCtx.remote.sandboxManager.createRepositoryWorkspace(
          repositoryUrl,
        );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.value;
    };
    const injected = () => ({ createWorkspaceAnchor });

    remoteCtx.slots.inject("conversation.hero.workspace.directoryFlow", () =>
      remoteCtx.slots.inject(
        "sidebar.workspaces.directoryFlow",
        function* registerRepositoryFlows() {
          yield remoteCtx.slots.register(
            {
              name: "conversation.hero.workspace.directoryFlow",
              inject: injected,
            },
            RepositoryDirectoryFlow,
          );
          yield remoteCtx.slots.register(
            {
              name: "sidebar.workspaces.directoryFlow",
              inject: injected,
            },
            RepositoryDirectoryFlow,
          );
        },
      ),
    );
  });

  // The stock settings controller's namespaces are traced services: a consumer
  // must name `remote.settings` and `remote.credentials` in its own inject.
  // The Sandboxes page talks to them directly rather than through the stock
  // browser mirror, which keeps settings writes process-local on every
  // non-loopback page — every page of a deployed control plane. Credential
  // writes are write-only and land in the host document, never in a sandbox.
  ctx.inject(
    ["remote.settings", "remote.credentials", "remote.sandboxManager"],
    (settingsCtx) => {
      const settings = settingsCtx.remote.settings;
      const credentials = settingsCtx.remote.credentials;
      const sandboxManager = settingsCtx.remote.sandboxManager;
      settingsCtx.slots.inject(
        "settings.section",
        function* registerSandboxesSection() {
          yield settingsCtx.slots.register(
            {
              name: "settings.section",
              id: "dsh-yawn.sandboxes",
              order: 32,
              label: "Sandboxes",
              inject: () => ({
                updateSettings: async (
                  ns: string,
                  patch: Record<string, JsonValue>,
                  expectedRevision: number | undefined,
                ) => unwrap(await settings.update(ns, patch, expectedRevision)),
                mutateSettings: async (
                  ns: string,
                  ops: SettingsPathOpView[],
                  expectedRevision: number | undefined,
                ) => unwrap(await settings.mutate(ns, ops, expectedRevision)),
                replaceSettings: async (
                  ns: string,
                  section: Record<string, JsonValue>,
                  expectedRevision: number | undefined,
                ) =>
                  unwrap(await settings.replace(ns, section, expectedRevision)),
                describeCredentials: async (refs: string[]) =>
                  unwrap(await credentials.describe(refs)),
                setCredential: async (ref: string, value: string) => {
                  unwrap(await credentials.set(ref, value));
                },
                unsetCredential: async (ref: string) => {
                  unwrap(await credentials.unset(ref));
                },
                getSandboxSettings: async () =>
                  unwrap(await sandboxManager.getSandboxSettings()),
              }),
            },
            SandboxesSettings,
          );
        },
      );
    },
  );

  // Turn notifications read the browser's own session list feed, so they run
  // from any page and need no host round-trip. The `sessions` service comes
  // from the stock session controller, not from a row of this bundle.
  //
  // The host package (`dsh-session`) declares the same `Context.sessions` key
  // for its own in-process store, and this package type-checks the host and
  // the browser in one program, so the merged property resolves to the host
  // type. The browser bundle mounts only the client controller, so the cast
  // names what is actually there at runtime.
  ctx.inject(["sessions"], (sessionCtx) => {
    const sessions = sessionCtx.sessions as unknown as ClientSessions;
    sessionCtx.effect(() => installTurnNotifications(sessions));
  });

  // Chat images load from `/api/file` with no session in the URL; add the
  // enclosing conversation's session so `sandbox-media-route` can read the
  // right sandbox on the host.
  ctx.effect(() => installMediaSession());

  ctx.slots.inject(
    "settings.section",
    function* registerNotificationsSection() {
      yield ctx.slots.register(
        {
          name: "settings.section",
          id: "dsh-yawn.notifications",
          order: 34,
          label: "Notifications",
        },
        NotificationsSettings,
      );
    },
  );

  return () => {
    void disposeRemote();
  };
}

export {
  RepositoryDirectoryFlow,
  type RepositoryDirectoryFlowProps,
} from "./repository-directory-flow.js";
