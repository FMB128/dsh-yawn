import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-storage-domain";
import { SessionId, type Session } from "@deepseek-ai/dsh-session";
// Type-only: puts the optional `webServer` service on the Context below.
import type {} from "@deepseek-ai/dsh-host-webserver";
// Type-only: puts the optional `settings` service on the Context below.
import type {} from "@deepseek-ai/dsh-settings";
import type {} from "@deepseek-ai/dsh-typert-registry";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

import { artifactsDirectory } from "../artifacts.js";
import { CredentialBroker, GLOBAL_SECRET_SCOPE } from "../broker.js";
import {
  resolveBuildkiteToken,
  type CredentialResolver,
} from "../buildkite-token.js";
import { CheckpointStore } from "../checkpoint.js";
import {
  configSchema,
  readSetting,
  resolveBootConfig,
  type Config,
  type ProfileConfig,
  type ResolvedConfig,
  type RuntimeConfig,
} from "../config.js";
import {
  dshHome,
  missingImportedProfiles,
  readDeploymentSettings,
} from "../deployment-settings.js";
import {
  FileIndexStore,
  type FileIndex,
  type FileIndexOptions,
} from "../file-index.js";
import { InstructionStore } from "../instruction-store.js";
import type { InstructionSettingsView } from "../instructions-remote.js";
import { ManagedInstructions } from "../managed-instructions.js";
import { MCP_OAUTH_CALLBACK_PATH, McpOAuth } from "../mcp-oauth.js";
import { McpPool } from "../mcp-pool.js";
import type { McpServerView, McpTestResult } from "../mcp-remote.js";
import { McpServerStore, type McpServerEntry } from "../mcp-store.js";
import { yawnHost } from "../remote-contributions.js";
import {
  PLACEHOLDER_PREVIEW_PORT,
  previewHost,
  previewLabel,
} from "../preview.js";
import { PreviewServer } from "../preview-server.js";
import { loadRegistrationToken } from "../registration-token.js";
import type { RunnerClient } from "../runner-client.js";
import type { SandboxSettingsView } from "../sandbox-settings-remote.js";
import type { SecretSettingsView } from "../secrets-remote.js";
import type { SandboxStatusView } from "../sandbox-status-remote.js";
import type { SessionProfileView } from "../session-profile-remote.js";
import { scratchWorkspacePath } from "../scratch-workspace.js";
import { SessionStore } from "../state-store.js";
import { TunnelServer, type RunnerGateway } from "../tunnel.js";
import {
  hasRepository,
  type BackendCapabilities,
  type BuildkiteProfile,
  type SandboxBackend,
} from "../types.js";
import {
  createRepositoryAnchor,
  normalizeWorkspaceRepositoryUrl,
  repositoryForAnchor,
  workspaceScopes,
  type WorkspaceScope,
} from "../workspace-anchor.js";
import { ArchiveRelease } from "./archive-release.js";
import { FileIndexHooks } from "./file-index-hooks.js";
import { IdleSchedule } from "./idle.js";
import { ProfileChoice } from "./profile-choice.js";
import { ProfileRegistry } from "./profile-registry.js";
import { RunnerAttachment } from "./runner-attachment.js";
import { rootSessionId } from "./root-session.js";
import { RuntimeSettings } from "./runtime-settings.js";
import { SandboxLifecycle } from "./sandbox-lifecycle.js";
import { SandboxNotices } from "./sandbox-notices.js";
import { SandboxStatus } from "./sandbox-status.js";

const execute = promisify(execFile);

export interface ManagerDependencies {
  /** Replacement backends by profile name; a profile missing here gets one built from its settings. */
  backends?: Record<string, SandboxBackend>;
  store?: SessionStore;
  broker?: CredentialBroker;
  gateway?: RunnerGateway;
  instructions?: InstructionStore;
  mcpStore?: McpServerStore;
  mcpPool?: McpPool;
  workspaceRegistry?: WorkspaceRegistryLike;
  /** Credential resolution for Buildkite tokens; defaults to the host service. */
  credentials?: CredentialResolver;
  /** Resolves a session id to its live agent; defaults to the agent registry. */
  agentLookup?: (sessionId: string) => Agent | undefined;
  /**
   * The deployment's own runtime settings, beneath the row config; defaults
   * to the file the chart mounts at /etc/dsh-yawn/sandbox-settings.yaml.
   */
  deploymentSettings?: RuntimeConfig;
}

interface WorkspaceRegistryLike {
  create(path: string, title?: string): Promise<{ path: string }>;
  list(): Array<{ path: string; title: string }>;
  /** Sessions archived in the Web UI; dsh offers no unarchive, so the set only grows. */
  readonly archivedSessionIds: readonly string[];
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    sandboxManager: SandboxManager;
  }
}

/**
 * The sandbox service surface dsh mounts: a Cordis plugin and typert RPC
 * host. All session machinery lives behind it — the lifecycle engine
 * (sandbox-lifecycle.ts), the runner attachment, the profile registry, and
 * the policies (idle, profile choice, file-index hooks) — wired
 * in the constructor; this class only composes them and delegates.
 */
export class SandboxManager extends TypertRemoteService {
  static inject = ["agents"];
  static Config = configSchema;

  readonly workspace: string;
  /** Host directory of the Scratch Workspace, whose sessions have no repository. */
  readonly scratchWorkspace: string;
  private readonly config: ResolvedConfig;
  /** The settings slice that can change while the host runs. */
  private readonly runtime: RuntimeSettings;
  private readonly broker: CredentialBroker;
  /** The tunnel credential the control plane generates and hands to runners. */
  private readonly registrationToken: string;
  private readonly ownedTunnel: TunnelServer | undefined;
  /** Started only when a preview domain is configured; see ResolvedConfig. */
  private readonly ownedPreview: PreviewServer | undefined;
  private readonly instructions: ManagedInstructions;
  private readonly mcpStore: McpServerStore;
  private readonly mcpPool: McpPool;
  private readonly mcpOAuth: McpOAuth;
  private readonly workspaceRegistry: WorkspaceRegistryLike | undefined;
  private readonly engine: SandboxLifecycle;
  private readonly registry: ProfileRegistry;
  private readonly idle: IdleSchedule;
  private readonly archiveRelease: ArchiveRelease;
  private readonly profileChoice: ProfileChoice;
  private readonly fileIndexHooks: FileIndexHooks;
  private readonly notices: SandboxNotices;
  private readonly attachment: RunnerAttachment;
  private readonly status: SandboxStatus;
  private readonly ready: Promise<void>;
  private readonly gateway: RunnerGateway;
  private readonly agentLookup: (sessionId: string) => Agent | undefined;
  private readonly rootSessions = new Map<string, string>();
  /**
   * The row config as the Loader mounted it. Its runtime fields are volatile
   * references once settings forms can edit them, so reading through them
   * sees every committed write without an event.
   */
  private readonly rawConfig: Config;
  /**
   * The deployment's own runtime settings, beneath the row config. They come
   * from an ordinary file rather than a patch layer: dsh 0.1.7 lets a home
   * patch shadow the profile patch, and the Web page could then neither save
   * nor restore a deployment profile.
   */
  private readonly deployment: RuntimeConfig;
  /** The profile map last applied to the registry, as JSON, for drift checks. */
  private appliedProfilesJson = "";
  /** Test-supplied credential resolution; production reads the host service. */
  private readonly credentialsOverride: CredentialResolver | undefined;

  constructor(
    ctx: Context,
    config: Config,
    dependencies: ManagerDependencies = {},
  ) {
    super(ctx, "sandboxManager");
    this.rawConfig = config;
    this.deployment =
      dependencies.deploymentSettings ?? readDeploymentSettings();
    // Settings-form writes land in the profile patch the Loader reads, so a
    // schema-valid but unusable value must not take the whole row down on the
    // next restart: degrade the editable slice, log why, keep booting.
    const boot = resolveBootConfig(config, this.deployment);
    for (const warning of boot.warnings) {
      ctx.logger("sandbox").warn(warning);
    }
    this.config = boot.config;
    this.workspace = this.config.workspace;
    if (Object.keys(this.config.profiles).length === 0) {
      ctx
        .logger("sandbox")
        .warn(
          "no sandbox profiles configured; add one to the sandbox-manager settings or no session can start a sandbox",
        );
    }
    this.warnAboutUnimportedProfiles();
    const store =
      dependencies.store ??
      new SessionStore(join(this.config.stateDir, "sessions.json"));
    this.broker =
      dependencies.broker ??
      new CredentialBroker({
        path: join(this.config.stateDir, "broker.json"),
      });
    this.mcpStore =
      dependencies.mcpStore ??
      new McpServerStore({ path: join(this.config.stateDir, "mcp.json") });
    this.mcpPool =
      dependencies.mcpPool ??
      new McpPool({
        ctx,
        store: this.mcpStore,
        warn: (message) => this.ctx.logger("sandbox").warn(message),
      });
    this.mcpOAuth = new McpOAuth({
      store: this.mcpStore,
      // The sign-in is saved by now; a failed remount shows on the server's
      // card, so it must not turn the callback page into "Sign-in failed".
      authorized: (serverName) =>
        this.mcpPool.sync().catch((reason: unknown) => {
          this.ctx
            .logger("sandbox")
            .warn(
              `MCP server ${serverName} signed in but could not be remounted: ${String(reason)}`,
            );
        }),
      warn: (message) => this.ctx.logger("sandbox").warn(message),
    });
    const fileIndexes = new FileIndexStore(
      join(this.config.stateDir, "file-index"),
    );
    this.registrationToken = loadRegistrationToken(this.config.stateDir);
    // After the token load, which creates the state directory on first boot.
    this.scratchWorkspace = scratchWorkspacePath(this.config.stateDir);
    if (dependencies.gateway === undefined) {
      this.ownedTunnel = new TunnelServer({
        port: this.config.tunnel.port,
        bind: this.config.tunnel.bind,
        tokens: [this.registrationToken],
        log: (message) => this.ctx.logger("sandbox").info(message),
      });
      this.gateway = this.ownedTunnel;
    } else {
      this.gateway = dependencies.gateway;
    }
    // Previews are configured by domain; without one there is no listener and
    // the Preview tab explains what is missing. The listener is deliberately
    // not the tunnel port: sandboxes can reach that one by design.
    if (this.config.preview.domain !== undefined) {
      this.ownedPreview = new PreviewServer({
        domain: this.config.preview.domain,
        port: this.config.preview.port,
        bind: this.config.preview.bind,
        gateway: this.gateway,
        log: (message) => this.ctx.logger("sandbox").info(message),
        onPreviewHit: (sandboxId) => this.markPreviewed(sandboxId),
      });
    }
    this.workspaceRegistry = dependencies.workspaceRegistry;
    this.credentialsOverride = dependencies.credentials;
    // The holder seeds its warning state from boot's, so the same degraded
    // slice is not logged twice, and resolves through the same piece-by-piece
    // logic: a broken profile never freezes the timers or later valid edits.
    this.runtime = new RuntimeSettings(
      {
        profiles: this.config.profiles,
        defaultProfile: this.config.defaultProfile,
        idleMs: this.config.idleMs,
        expiresAfterMs: this.config.expiresAfterMs,
        readyTimeoutMs: this.config.readyTimeoutMs,
      },
      boot.warnings,
      () => this.rawConfig,
      this.config.tunnel.port,
      (warnings) => {
        for (const warning of warnings) {
          this.ctx.logger("sandbox").warn(warning);
        }
      },
      this.deployment,
    );
    this.appliedProfilesJson = JSON.stringify(this.runtime.profiles);
    this.profileChoice = new ProfileChoice(this.runtime, store);
    const runtime = this.runtime;
    const attachment = new RunnerAttachment({
      gateway: this.gateway,
      broker: this.broker,
      revision: this.config.revision,
      workspace: this.config.workspace,
    });
    this.attachment = attachment;
    // The status read gets the store, the profile map, and a runner lookup —
    // deliberately not the engine, so it cannot provision or wake.
    const previewDomain = this.config.preview.domain;
    this.status = new SandboxStatus({
      store,
      profiles: () => this.runtime.profiles,
      runnerFor: (sessionId) => attachment.clientFor(sessionId),
      ...(previewDomain === undefined
        ? {}
        : {
            previewDomain,
            previewHost: (sandboxId: string) =>
              previewHost(previewDomain, sandboxId, PLACEHOLDER_PREVIEW_PORT),
          }),
    });
    this.registry = new ProfileRegistry(
      this.config.profiles,
      dependencies.backends,
      this.registrationToken,
      (profile) => this.buildkiteToken(profile),
    );
    this.engine = new SandboxLifecycle({
      store,
      registry: this.registry,
      pendingProfile: (sessionId) => this.profileChoice.pending(sessionId),
      attachment,
      checkpoints: new CheckpointStore(
        join(this.config.stateDir, "checkpoints"),
      ),
      // Read through the runtime holder: a settings change applies to the
      // next hibernation without a restart.
      get expiresAfterMs() {
        return runtime.expiresAfterMs;
      },
      warn: (message) => ctx.logger("sandbox").warn(message),
    });
    this.fileIndexHooks = new FileIndexHooks({
      fileIndexes,
      store,
      workspace: this.config.workspace,
      warn: (message) => this.ctx.logger("sandbox").warn(message),
    });
    // Hooks run in registration order; file-index capture is the only
    // beforeHibernate/beforeCheckpoint step today. Add new features that run
    // while the sandbox still answers here.
    this.engine.addHooks(this.fileIndexHooks);
    // A completed restore or wake queues the turn's notice; the pre-step
    // listener installed below rides it onto exactly that turn's prompt.
    this.notices = new SandboxNotices(ctx, {
      rootSessionId: (agent) => this.rootSessionId(agent),
      artifactsDirectory: () => artifactsDirectory(this.workspace),
    });
    this.engine.addHooks(this.notices);
    this.instructions = new ManagedInstructions(ctx, {
      store:
        dependencies.instructions ??
        new InstructionStore(join(this.config.stateDir, "instructions.json")),
      stateDir: this.config.stateDir,
      ensureRunning: (agent) => this.ensureRunning(agent),
      // The Scratch Workspace is no scope: global instructions only.
      repositoryForAgent: (agent) => {
        const record = this.engine.record(this.rootSessionId(agent));
        return record !== undefined && hasRepository(record)
          ? record.repositoryUrl
          : undefined;
      },
      workspaceRegistry: () =>
        this.workspaceRegistry ??
        (this.ctx.get("workspaceRegistry") as
          | WorkspaceRegistryLike
          | undefined),
    });
    this.idle = new IdleSchedule({
      // Read through the runtime holder: a settings change applies to every
      // countdown armed after it. Timers already armed keep their old delay.
      // The session's own profile may set its delay; a record whose profile
      // is gone uses the top-level one.
      idleMsFor: (sessionId) => {
        const name = this.engine.record(sessionId)?.profile;
        const profile = name === undefined ? undefined : runtime.profiles[name];
        return profile?.idleMs ?? runtime.idleMs;
      },
      ready: () => this.ready,
      hibernate: (sessionId, guard) => this.engine.hibernate(sessionId, guard),
      warn: (message) => this.ctx.logger("sandbox").warn(message),
    });
    this.archiveRelease = new ArchiveRelease({
      ready: () => this.ready,
      lifecycle: this.engine,
      archivedSessionIds: () => this.archivedSessionIds(),
      isTurnLive: (sessionId) => this.idle.isTurnLive(sessionId),
      warn: (message) => this.ctx.logger("sandbox").warn(message),
    });
    this.agentLookup =
      dependencies.agentLookup ??
      ((sessionId) => {
        // The host always mounts the agent registry before this manager;
        // tests may construct the manager against a bare context.
        const registry = this.ctx.agents as
          | { get(id: ReturnType<typeof SessionId>): Agent | undefined }
          | undefined;
        return registry?.get(SessionId(sessionId));
      });
    this.ready = this.initialize();

    // The Web API requires a directory-picker capability. This package owns
    // the browser flow instead, so expose an unknown kind that makes the stock
    // folder RPCs unavailable without loading their competing browser plugin.
    ctx.provide("directoryPicker", {
      capability: () => ({ kind: "repository" }),
    });

    ctx.inject(["typert"], (typertCtx) => {
      typertCtx.typert.register(yawnHost);
    });
    // The OAuth callback is a browser navigation back from the authorization
    // server, so it needs the Web surface's server; headless has none.
    ctx.inject(["webServer"], (webCtx) => {
      webCtx.effect(
        () =>
          webCtx.webServer.register({
            kind: "exact",
            path: MCP_OAUTH_CALLBACK_PATH,
            handler: (request, response) =>
              this.mcpOAuth.handleCallback(request, response),
          }),
        `sandbox-manager: ${MCP_OAUTH_CALLBACK_PATH} route`,
      );
    });

    // Provisioning waits for the first prompt: `agent/created` fires as soon
    // as a blank session exists, before the user has picked a profile.
    // ManagedInstructions.install() calls ensureRunning at `agent/pre-step`.
    this.instructions.install();
    // After it, so the notice listener reads only when next() has already run
    // the ensureRunning hooks for this step.
    this.notices.install();
    ctx.on("agent/status", ({ agent, status }) => {
      if (status === "running") {
        this.idle.markActive(this.rootSessionId(agent));
      }
    });
    ctx.on("session/event", (session, event) => {
      const sessionId = this.rootSessionIdOfSession(session);
      if (event.type === "turn/start") {
        this.idle.beginTurn(sessionId);
      } else if (event.type === "turn/end") {
        this.idle.endTurn(sessionId);
        // An archive that landed mid-turn waits for the turn to finish.
        this.archiveRelease.reconcile();
      }
    });
    // Archive release: dsh records archives in its workspace domain, so any
    // write there (and the registry becoming readable at boot) is a chance to
    // reconcile. Both are cheap: read the set, scan the few session records.
    ctx.on("domain/changed", (change) => {
      if (change.domain === "workspace") {
        this.archiveRelease.reconcile();
      }
    });
    ctx.inject(["workspaceRegistry"], () => {
      this.archiveRelease.reconcile();
    });
    // Renewed OAuth tokens are new headers, and an expired one must stop
    // being sent, so every tick ends with a reconcile of the mounts. Ticks
    // start once boot has mounted the servers, and a tick that outlives
    // disposal must not mount anything.
    ctx.effect(() => {
      let stopped = false;
      let timer: NodeJS.Timeout | undefined;
      const tick = async () => {
        await this.mcpOAuth.renewDue();
        if (stopped) {
          return;
        }
        try {
          await this.mcpPool.sync();
        } catch (reason) {
          this.ctx
            .logger("sandbox")
            .warn(`MCP servers could not be reconciled: ${String(reason)}`);
        }
      };
      this.ready.then(
        () => {
          if (stopped) {
            return;
          }
          void tick();
          timer = setInterval(() => void tick(), 60_000);
          timer.unref();
        },
        // A failed boot is reported by everything that awaits `ready`.
        () => {},
      );
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    });
    ctx.effect(() => () => {
      this.idle.dispose();
      void this.ownedTunnel?.close();
      void this.ownedPreview?.close();
      void this.mcpPool.dispose();
    });
  }

  /** Load the stores, recover expired sandboxes, and arm boot idle timers. */
  private async initialize(): Promise<void> {
    await Promise.all([
      this.broker.initialize(),
      this.ownedTunnel?.listen(),
      this.ownedPreview?.listen(),
      this.instructions.initialize(),
      this.mcpStore.initialize(),
    ]);
    void this.prepareBackends();
    await this.engine.initialize();
    // Mounting is asynchronous past ctx.plugin, so configured MCP servers are
    // reconnected at boot without holding up the manager.
    await this.mcpPool.sync();
    for (const record of this.engine.records()) {
      if (record.state === "running") {
        this.idle.schedule(record.sessionId);
      }
    }
    await this.warnUnusableBuildkiteProfiles();
  }

  /**
   * The API token of one Buildkite profile, resolved per request from the
   * host credential service (the per-profile credential written by the
   * Sandboxes page, then `BUILDKITE_API_TOKEN` in the process environment).
   */
  private buildkiteToken(profile: BuildkiteProfile): Promise<string> {
    return resolveBuildkiteToken(
      profile,
      this.credentialsOverride ?? this.ctx.get("credentials"),
    );
  }

  /**
   * A Buildkite profile whose token cannot be resolved does not stop the host:
   * the token is entered in the Web UI, so the host must stay up for the
   * operator to fix it. Each such profile is named once at boot; its sessions
   * fail at their first prompt with the same message.
   */
  private async warnUnusableBuildkiteProfiles(): Promise<void> {
    for (const profile of Object.values(this.runtime.profiles)) {
      if (profile.backend !== "buildkite") {
        continue;
      }
      try {
        await this.buildkiteToken(profile);
      } catch (error) {
        this.ctx
          .logger("sandbox")
          .warn(
            `${errorMessage(error)}; sessions on this profile fail until it is set`,
          );
      }
    }
  }

  /**
   * Rebuild the profile registry when the profile map changed since the last
   * applied one. Volatile config carries no change event, so this runs at
   * the provisioning choke points — the earliest moment new profiles can
   * matter. The registry rebuild is atomic: a backend that cannot be built
   * throws before anything swaps, the previous settings stay applied, and
   * the next call retries.
   */
  private syncRuntimeSettings(): void {
    const profiles = this.runtime.profiles;
    const json = JSON.stringify(profiles);
    if (json === this.appliedProfilesJson) {
      return;
    }
    try {
      this.registry.update(profiles);
    } catch (error) {
      this.ctx
        .logger("sandbox")
        .warn(
          `keeping the previous sandbox profiles; one of the new profiles cannot start: ${errorMessage(error)}`,
        );
      return;
    }
    this.appliedProfilesJson = json;
    const names = Object.keys(profiles).sort().join(", ");
    this.ctx
      .logger("sandbox")
      .info(`sandbox profiles are now: ${names === "" ? "(none)" : names}`);
    void this.prepareBackends();
  }

  /** Resolve the current foreground agent and return its live runner. */
  clientForCurrentAgent(): Promise<RunnerClient> {
    return this.ensureRunning(this.ctx.agents.requireInitiator());
  }

  /**
   * Note activity from outside the agent loop, such as a keystroke in an open
   * interactive terminal, so a running sandbox is not hibernated while its
   * terminal is in use. Nothing starts or wakes: a session without a running
   * sandbox has nothing to keep alive, and its terminal is already gone.
   */
  noteActivity(agent: Agent): void {
    const sessionId = this.rootSessionId(agent);
    if (this.engine.record(sessionId)?.state !== "running") {
      return;
    }
    this.idle.markActive(sessionId);
    this.idle.schedule(sessionId);
  }

  /**
   * The root session owning the calling agent's sandbox, or undefined outside
   * an agent boundary. Attachment copies are keyed by this id, so a subagent
   * and its root session resolve to the same copy. Synchronous: the
   * filesystem mapping runs during request assembly and cannot await.
   */
  rootSessionIdForCurrentAgent(): string | undefined {
    try {
      return this.rootSessionId(this.ctx.agents.requireInitiator());
    } catch {
      return undefined;
    }
  }

  /**
   * What the agent's sandbox keeps across a sleep, for the model-facing
   * environment section. Resolved on each prompt assembly, so a profile
   * chosen after the agent exists is reflected; a session with no profile
   * configured answers undefined and the text stays cautious.
   */
  sandboxCapabilitiesFor(agent: Agent): BackendCapabilities | undefined {
    const profile = this.profileChoice.current(this.rootSessionId(agent));
    return profile === undefined
      ? undefined
      : this.registry.backendOf(profile.name)?.capabilities;
  }

  /**
   * The address pattern this sandbox's HTTP servers are served at, for the
   * sandbox environment prompt: `https://<label>.<domain>/` with PORT where
   * the server's port goes. Undefined while previews are unconfigured or the
   * session has no sandbox yet; the prompt resolves it on each assembly, so
   * the sentence appears from the first prompt after provisioning.
   */
  previewOriginFor(agent: Agent): string | undefined {
    const domain = this.config.preview.domain;
    if (domain === undefined) {
      return undefined;
    }
    const record = this.engine.record(this.rootSessionId(agent));
    if (
      record === undefined ||
      !("sandboxId" in record) ||
      record.sandboxId === undefined
    ) {
      return undefined;
    }
    return `https://${previewLabel(record.sandboxId, "PORT")}.${domain}/`;
  }

  /** Create and register the host Workspace selected by repository URL in Web. */
  async createRepositoryWorkspace(repositoryUrl: string): Promise<string> {
    const registry =
      this.workspaceRegistry ??
      (this.ctx.get("workspaceRegistry") as WorkspaceRegistryLike | undefined);
    if (registry === undefined) {
      throw new Error("repository workspaces require the dsh Web profile");
    }
    const anchor = await createRepositoryAnchor(
      this.config.stateDir,
      repositoryUrl,
    );
    return (await registry.create(anchor.path, anchor.title)).path;
  }

  /**
   * Whether the agent runs in the Scratch Workspace, and so in a sandbox with
   * no repository. Synchronous, for the system prompt. A session that has a
   * sandbox answers from its record, which stays right even if `stateDir`
   * moves; before that, from its cwd, which is fixed when the session is
   * created and which a subagent inherits from its parent.
   */
  inScratchWorkspace(agent: Agent): boolean {
    const record = this.engine.record(this.rootSessionId(agent));
    if (record !== undefined) {
      return !hasRepository(record);
    }
    const cwd = agent.session.header.cwd;
    return cwd !== undefined && resolve(cwd) === this.scratchWorkspace;
  }

  /**
   * The Secrets page's read model: one name list per scope, values never
   * included. Refresh first so edits made outside the host appear.
   */
  async getSecrets(): Promise<SecretSettingsView> {
    await this.ready;
    await this.broker.refresh();
    return this.secretSettings();
  }

  /** Store one global secret; values never flow back. */
  async setGlobalSecret(
    name: string,
    value: string,
  ): Promise<SecretSettingsView> {
    await this.ready;
    await this.broker.setSecret(GLOBAL_SECRET_SCOPE, name, value);
    return this.secretSettings();
  }

  /** Store one workspace secret, overriding a global secret of the same name. */
  async setWorkspaceSecret(
    repositoryUrl: string,
    name: string,
    value: string,
  ): Promise<SecretSettingsView> {
    await this.ready;
    await this.setRegisteredWorkspaceSecret(repositoryUrl, (normalized) =>
      this.broker.setSecret(
        { kind: "workspace", repositoryUrl: normalized },
        name,
        value,
      ),
    );
    return this.secretSettings();
  }

  async deleteGlobalSecret(name: string): Promise<SecretSettingsView> {
    await this.ready;
    await this.broker.deleteSecret(GLOBAL_SECRET_SCOPE, name);
    return this.secretSettings();
  }

  async deleteWorkspaceSecret(
    repositoryUrl: string,
    name: string,
  ): Promise<SecretSettingsView> {
    await this.ready;
    await this.setRegisteredWorkspaceSecret(repositoryUrl, (normalized) =>
      this.broker.deleteSecret(
        { kind: "workspace", repositoryUrl: normalized },
        name,
      ),
    );
    return this.secretSettings();
  }

  /** Add or replace one Git host's credential mapping. */
  async setGitHost(
    host: string,
    username: string,
    secret: string,
  ): Promise<SecretSettingsView> {
    await this.ready;
    await this.broker.setGitHost(host, username, secret);
    return this.secretSettings();
  }

  async deleteGitHost(host: string): Promise<SecretSettingsView> {
    await this.ready;
    await this.broker.deleteGitHost(host);
    return this.secretSettings();
  }

  /** Configured MCP servers with their live connection status. */
  async listMcpServers(): Promise<McpServerView[]> {
    await this.ready;
    await this.mcpPool.sync();
    return this.mcpPool.views();
  }

  /** Add or update one MCP server, then reconcile its live mount. */
  async setMcpServer(entry: McpServerEntry): Promise<McpServerView[]> {
    await this.ready;
    await this.mcpStore.upsert(entry);
    await this.mcpPool.sync();
    return this.mcpPool.views();
  }

  async deleteMcpServer(serverName: string): Promise<McpServerView[]> {
    await this.ready;
    await this.mcpStore.remove(serverName);
    await this.mcpPool.sync();
    return this.mcpPool.views();
  }

  /**
   * Connect one stored server again. The client stops reconnecting once its
   * attempt budget runs out, so this is the only way back short of a restart.
   */
  async retryMcpServer(serverName: string): Promise<McpServerView[]> {
    await this.ready;
    await this.mcpPool.retry(serverName);
    return this.mcpPool.views();
  }

  /** Try one configuration without saving it; the probe is always disposed. */
  async testMcpServer(entry: McpServerEntry): Promise<McpTestResult> {
    await this.ready;
    return this.mcpPool.testConnection(entry);
  }

  /** Begin an OAuth sign-in for one saved server; answers the URL to open. */
  async startMcpAuthorization(
    serverName: string,
    origin: string,
  ): Promise<string> {
    await this.ready;
    return this.mcpOAuth.start(serverName, origin);
  }

  async getInstructions(): Promise<InstructionSettingsView> {
    await this.ready;
    return this.instructions.getSettings();
  }

  async setGlobalInstructions(
    content: string,
  ): Promise<InstructionSettingsView> {
    await this.ready;
    return this.instructions.setGlobal(content);
  }

  async setWorkspaceInstructions(
    repositoryUrl: string,
    content: string,
  ): Promise<InstructionSettingsView> {
    await this.ready;
    return this.instructions.setWorkspace(repositoryUrl, content);
  }

  /** Profile choices for the composer chip; `locked` once a sandbox exists. */
  async getSessionProfile(sessionId: string): Promise<SessionProfileView> {
    await this.ready;
    return this.profileChoice.view(sessionId);
  }

  async setSessionProfile(
    sessionId: string,
    profile: string,
  ): Promise<SessionProfileView> {
    await this.ready;
    return this.profileChoice.set(sessionId, profile);
  }

  /**
   * The Sandboxes page's read model: the deployment's profiles and the page's
   * own edits combined here, so the page never merges the two. Deployment
   * profiles come first and are locked; the page's profiles follow. The page's
   * default profile and timers win over the deployment's, and the revision is
   * the one a write must carry.
   */
  getSandboxSettings(): SandboxSettingsView {
    const chart = readSetting(this.deployment.profiles) ?? {};
    const page = readSetting(this.rawConfig.profiles) ?? {};
    const profiles: Record<string, ProfileConfig> = { ...chart };
    for (const [name, profile] of Object.entries(page)) {
      profiles[name] ??= profile;
    }
    const form = this.settingsForm();
    // The scalars come from the resolved runtime slice, so the page shows
    // what the host actually applies: a page default that names a removed
    // profile, for example, reads as the fallback the runtime picked.
    const defaultProfile = this.runtime.defaultProfile;
    const readyTimeoutMs = this.runtime.readyTimeoutMs;
    const resolved = this.runtime.profiles;
    return {
      profiles: Object.entries(profiles).map(([name, profile]) => {
        const applied = resolved[name];
        return {
          name,
          backend: profile.backend,
          fields: stringFields(profile),
          locked: chart[name] !== undefined,
          idleMs: applied?.idleMs ?? this.runtime.idleMs,
          ...(applied !== undefined && "readyTimeoutMs" in applied
            ? { readyTimeoutMs: applied.readyTimeoutMs }
            : {}),
        };
      }),
      ...(defaultProfile === undefined ? {} : { defaultProfile }),
      idleMs: this.runtime.idleMs,
      expiresAfterMs: this.runtime.expiresAfterMs,
      ...(readyTimeoutMs === undefined ? {} : { readyTimeoutMs }),
      overridden: {
        defaultProfile:
          readSetting(this.rawConfig.defaultProfile) !== undefined,
        idleMs: readSetting(this.rawConfig.idleMs) !== undefined,
        expiresAfterMs:
          readSetting(this.rawConfig.expiresAfterMs) !== undefined,
        readyTimeoutMs:
          readSetting(this.rawConfig.readyTimeoutMs) !== undefined,
      },
      revision: form?.revision ?? 0,
      writable: form?.writable ?? false,
    };
  }

  /**
   * The settings form a write goes through: its entry revision and whether
   * the profile accepts writes. Absent when no settings service is mounted,
   * which leaves the page read-only.
   */
  private settingsForm(): { revision: number; writable: boolean } | undefined {
    const settings = this.ctx.get("settings");
    if (settings === undefined) {
      return undefined;
    }
    const descriptor = settings
      .describe()
      .find((row) => row.ns === "sandbox-manager");
    return descriptor === undefined
      ? undefined
      : { revision: descriptor.revision, writable: settings.writable };
  }

  /**
   * A settings document renamed to `settings.yaml.imported` can still hold
   * sandbox profiles the host does not have: a boot that mounted the sandbox
   * settings as a home patch had dsh's one-time import refused for this row.
   * Say so loudly, because the alternative is an operator wondering where the
   * profiles went. This goes to stderr, not the plugin logger: the startup
   * logger's warnings reach the operator only when boot fails.
   */
  private warnAboutUnimportedProfiles(): void {
    const importedPath = join(dshHome(), "settings.yaml.imported");
    const missing = missingImportedProfiles(
      importedPath,
      Object.keys(this.config.profiles),
    );
    if (missing.length === 0) {
      return;
    }
    process.stderr.write(
      `dsh-yawn: sandbox profile(s) ${missing.join(", ")} are only in ${importedPath}; the boot that renamed that file could not import them. Rename it back to settings.yaml and restart to restore them.\n`,
    );
  }

  /**
   * Facts for the session's Sandbox tab. Reading is inert: see SandboxStatus,
   * which holds no lifecycle engine and so cannot provision or wake.
   */
  async getSandboxStatus(sessionId: string): Promise<SandboxStatusView> {
    await this.ready;
    return this.status.view(sessionId);
  }

  /**
   * Start each backend's early work, such as the Kubernetes backend storing
   * the runner token so the warm pool's pods can start. Nothing waits
   * on it: a backend repeats what a session needs before serving it, so a
   * failure here is only logged. Backends kept from before cost nothing.
   * Backends run concurrently, so one unreachable cluster does not hold up
   * the others.
   */
  private async prepareBackends(): Promise<void> {
    await Promise.all(
      this.registry.allBackends().map(async (backend) => {
        try {
          await backend.prepare?.();
        } catch (error) {
          this.ctx
            .logger("sandbox")
            .warn(`${backend.name} backend: ${errorMessage(error)}`);
        }
      }),
    );
  }

  /**
   * The preview listener's bound port, or undefined when previews are not
   * configured. The listener binds port 0 in tests, so this is how they reach
   * it; operations get the same number for a health check.
   */
  previewPort(): number | undefined {
    return this.ownedPreview?.port();
  }

  /**
   * A previewed sandbox is being looked at, which is activity: an armed idle
   * countdown is cancelled and re-armed, so a sandbox does not hibernate
   * under its viewer.
   */
  private markPreviewed(sandboxId: string): void {
    for (const record of this.engine.records()) {
      if (
        record.state === "running" &&
        "sandboxId" in record &&
        record.sandboxId === sandboxId
      ) {
        this.idle.markActive(record.sessionId);
        this.idle.schedule(record.sessionId);
        return;
      }
    }
  }

  /**
   * A session is about to run: provision, wake, or recover its sandbox and
   * answer with the live runner. Subagent sessions resolve to their root
   * session's sandbox, so a child's first tool call boots the root's sandbox
   * and every agent in one session tree shares one working copy.
   */
  async ensureRunning(agent: Agent): Promise<RunnerClient> {
    await this.ready;
    this.syncRuntimeSettings();
    const sessionId = this.rootSessionId(agent);
    this.idle.markActive(sessionId);
    // Resolve the repository through the root agent when it is live: the
    // child inherits its cwd at creation, so both resolve identically, and
    // this keeps the provenance local to the sandbox being served.
    const rootAgent = this.agentLookup(sessionId) ?? agent;
    const client = await this.engine.ensureRunning(sessionId, () =>
      this.repositoryFor(rootAgent),
    );
    // markActive cancelled any armed countdown above, and a wake never
    // guarantees a turn follows (a created session can idle out untouched),
    // so re-arm here: a running record must always carry an idle timer.
    this.idle.schedule(sessionId);
    return client;
  }

  /** Suspend the session's sandbox: hibernate, or checkpoint and destroy. */
  async hibernate(sessionId: string): Promise<void> {
    await this.ready;
    await this.engine.hibernate(sessionId);
  }

  /**
   * Destroy the sandbox and drop the record of one session, whatever state it
   * is in. Skips a session with a live turn — a mid-stream destroy fails the
   * whole turn, so callers re-trigger after turn/end. Host-event features (an
   * archived session, an operator command) release through this verb.
   */
  async release(sessionId: string): Promise<void> {
    await this.ready;
    await this.engine.release(
      sessionId,
      () => !this.idle.isTurnLive(sessionId),
    );
  }

  /** The host's archive set, read through the workspace registry. */
  private archivedSessionIds(): readonly string[] {
    const registry =
      this.workspaceRegistry ??
      (this.ctx.get("workspaceRegistry") as WorkspaceRegistryLike | undefined);
    return registry?.archivedSessionIds ?? [];
  }

  /** Every scope the settings pages offer, from the live workspace registry. */
  private async scopes(): Promise<WorkspaceScope[]> {
    const registry =
      this.workspaceRegistry ??
      (this.ctx.get("workspaceRegistry") as WorkspaceRegistryLike | undefined);
    return registry === undefined
      ? []
      : workspaceScopes(this.config.stateDir, registry.list());
  }

  /** The Secrets page's read model over the broker's name lists and Git table. */
  private async secretSettings(): Promise<SecretSettingsView> {
    return {
      global: this.broker.secretNames(GLOBAL_SECRET_SCOPE),
      workspaces: (await this.scopes()).map((scope) => ({
        ...scope,
        names: this.broker.secretNames({
          kind: "workspace",
          repositoryUrl: scope.repositoryUrl,
        }),
      })),
      gitHosts: this.broker.gitHosts(),
    };
  }

  /**
   * Run one workspace-scoped broker write after checking the workspace is
   * registered, so a mistyped URL cannot create an unreachable scope.
   */
  private async setRegisteredWorkspaceSecret(
    repositoryUrl: string,
    apply: (normalized: string) => Promise<void>,
  ): Promise<void> {
    const normalized = normalizeWorkspaceRepositoryUrl(repositoryUrl);
    const scopes = await this.scopes();
    if (!scopes.some((scope) => scope.repositoryUrl === normalized)) {
      throw new Error(`workspace is not registered: ${normalized}`);
    }
    await apply(normalized);
  }

  /**
   * The "@" file-reference row saves a workspace index as each sandbox
   * hibernates, so discovery can answer for a hibernated session without
   * waking it. The capture lives in FileIndexHooks.
   */
  indexFilesOnHibernate(options: FileIndexOptions): void {
    this.fileIndexHooks.enable(options);
  }

  /**
   * The file index saved when this session hibernated. Undefined while the
   * sandbox is running (ask the runner instead), or when no index was saved.
   */
  async hibernatedFileIndex(agent: Agent): Promise<FileIndex | undefined> {
    await this.ready;
    return this.fileIndexHooks.hibernatedFileIndex(this.rootSessionId(agent));
  }

  /**
   * Whether the session has a sandbox record, in any state. Inert, like the
   * Sandbox tab: a store read that cannot provision or wake. The "@" file
   * reference asks this before falling back to a runner walk, so the
   * completion menu never creates a session's first sandbox.
   */
  async hasSandbox(agent: Agent): Promise<boolean> {
    await this.ready;
    return this.engine.record(this.rootSessionId(agent)) !== undefined;
  }

  /**
   * The top-level session whose sandbox serves this agent's work, memoized
   * per session id: resolution reads the live agent registry, so an ancestor
   * disposed mid-run would otherwise flip the session onto a different
   * sandbox. Once resolved, a session keeps its root for this process.
   */
  private rootSessionId(agent: Agent): string {
    const sessionId = String(agent.id);
    let root = this.rootSessions.get(sessionId);
    if (root === undefined) {
      root = rootSessionId(agent, this.agentLookup);
      this.rootSessions.set(sessionId, root);
      if (
        root === sessionId &&
        agent.session.header.origin === "subagent" &&
        agent.session.header.parentSession !== undefined
      ) {
        this.ctx
          .logger("sandbox")
          .warn(
            `subagent session ${sessionId} cannot resolve its parent session ${String(agent.session.header.parentSession)} live; serving it from its own sandbox`,
          );
      }
    }
    return root;
  }

  /**
   * Same resolution for a bare session event: the session's live agent owns
   * the lineage; an unknown session is its own root. The memo is consulted
   * first, so a session whose agent is already gone keys on the same root
   * its earlier events did — a turn/end under the raw id would strand a
   * live-turn count on the root and stop the sandbox from ever idling.
   */
  private rootSessionIdOfSession(session: Session): string {
    const sessionId = String(session.id);
    const memoized = this.rootSessions.get(sessionId);
    if (memoized !== undefined) {
      return memoized;
    }
    const agent = this.agentLookup(sessionId);
    return agent === undefined ? sessionId : this.rootSessionId(agent);
  }

  /** The session's repository URL; empty in the Scratch Workspace. */
  private async repositoryFor(agent: Agent): Promise<string> {
    if (this.inScratchWorkspace(agent)) {
      return "";
    }
    const cwd = agent.session.header.cwd;
    if (cwd !== undefined) {
      const repository = await repositoryForAnchor(this.config.stateDir, cwd);
      if (repository !== undefined) {
        return repository;
      }
    }
    if (this.config.repository !== undefined) {
      return this.config.repository;
    }
    if (cwd === undefined) {
      throw new Error(
        "sandbox repository is not configured and the dsh session has no cwd",
      );
    }
    try {
      const { stdout } = await execute("git", [
        "-C",
        cwd,
        "remote",
        "get-url",
        "origin",
      ]);
      const repository = stdout.trim();
      if (repository.length === 0) {
        throw new Error("origin is empty");
      }
      return repository;
    } catch (error) {
      throw new Error(
        `cannot resolve a repository from ${cwd}; configure repository explicitly`,
        {
          cause: error,
        },
      );
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The scalar profile fields, `backend` aside, as the settings page edits them. */
function stringFields(profile: ProfileConfig): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(profile)) {
    if (key !== "backend" && typeof value !== "object") {
      fields[key] = String(value);
    }
  }
  return fields;
}

export default SandboxManager;
