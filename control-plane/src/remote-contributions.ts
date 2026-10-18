import type { TypertContribution } from "@deepseek-ai/dsh-typert-registry/types";
import type { TypertRemoteContribution } from "@deepseek-ai/dsh-typert-protocol";

import type { SandboxInstructionsRemote } from "./instructions-remote.js";
import { sandboxInstructionsDescriptors } from "./instructions-remote.js";
import type { SandboxMcpRemote } from "./mcp-remote.js";
import { sandboxMcpDescriptors } from "./mcp-remote.js";
import type { RepositoryWorkspaceRemote } from "./repository-workspace-remote.js";
import { repositoryWorkspaceDescriptors } from "./repository-workspace-remote.js";
import type { SandboxSettingsRemote } from "./sandbox-settings-remote.js";
import { sandboxSettingsDescriptors } from "./sandbox-settings-remote.js";
import type { SandboxStatusRemote } from "./sandbox-status-remote.js";
import { sandboxStatusDescriptors } from "./sandbox-status-remote.js";
import type { SandboxSecretsRemote } from "./secrets-remote.js";
import { sandboxSecretsDescriptors } from "./secrets-remote.js";
import type { SessionProfileRemote } from "./session-profile-remote.js";
import { sessionProfileDescriptors } from "./session-profile-remote.js";

/** Everything the sandboxManager service exposes to the browser. */
type SandboxManagerRemote = RepositoryWorkspaceRemote &
  SandboxSecretsRemote &
  SandboxInstructionsRemote &
  SandboxMcpRemote &
  SessionProfileRemote &
  SandboxStatusRemote &
  SandboxSettingsRemote;

declare module "@deepseek-ai/dsh-typert-protocol" {
  interface TypertRemoteNamespaceMap {
    sandboxManager: SandboxManagerRemote;
  }

  interface TypertRemoteMap {
    "sandboxManager/createRepositoryWorkspace": SandboxManagerRemote["createRepositoryWorkspace"];
    "sandboxManager/getSecrets": SandboxManagerRemote["getSecrets"];
    "sandboxManager/setGlobalSecret": SandboxManagerRemote["setGlobalSecret"];
    "sandboxManager/setWorkspaceSecret": SandboxManagerRemote["setWorkspaceSecret"];
    "sandboxManager/deleteGlobalSecret": SandboxManagerRemote["deleteGlobalSecret"];
    "sandboxManager/deleteWorkspaceSecret": SandboxManagerRemote["deleteWorkspaceSecret"];
    "sandboxManager/setGitHost": SandboxManagerRemote["setGitHost"];
    "sandboxManager/deleteGitHost": SandboxManagerRemote["deleteGitHost"];
    "sandboxManager/listMcpServers": SandboxManagerRemote["listMcpServers"];
    "sandboxManager/setMcpServer": SandboxManagerRemote["setMcpServer"];
    "sandboxManager/deleteMcpServer": SandboxManagerRemote["deleteMcpServer"];
    "sandboxManager/retryMcpServer": SandboxManagerRemote["retryMcpServer"];
    "sandboxManager/testMcpServer": SandboxManagerRemote["testMcpServer"];
    "sandboxManager/startMcpAuthorization": SandboxManagerRemote["startMcpAuthorization"];
    "sandboxManager/getInstructions": SandboxManagerRemote["getInstructions"];
    "sandboxManager/setGlobalInstructions": SandboxManagerRemote["setGlobalInstructions"];
    "sandboxManager/setWorkspaceInstructions": SandboxManagerRemote["setWorkspaceInstructions"];
    "sandboxManager/getSessionProfile": SandboxManagerRemote["getSessionProfile"];
    "sandboxManager/setSessionProfile": SandboxManagerRemote["setSessionProfile"];
    "sandboxManager/getSandboxStatus": SandboxManagerRemote["getSandboxStatus"];
    "sandboxManager/getSandboxSettings": SandboxManagerRemote["getSandboxSettings"];
  }
}

// typert accepts one contribution per package face and one remote contribution
// per package, so every browser-facing invocation this package owns must be
// registered together.
const descriptors = [
  ...repositoryWorkspaceDescriptors,
  ...sandboxSecretsDescriptors,
  ...sandboxInstructionsDescriptors,
  ...sandboxMcpDescriptors,
  ...sessionProfileDescriptors,
  ...sandboxStatusDescriptors,
  ...sandboxSettingsDescriptors,
];

export const yawnHost: TypertContribution = {
  package: "@zhming0/dsh-yawn",
  face: "host",
  schemas: [],
  invocations: descriptors,
  model: { services: [], events: [], objects: [] },
};

export const yawnRemote: TypertRemoteContribution = {
  package: "@zhming0/dsh-yawn",
  descriptors,
};
