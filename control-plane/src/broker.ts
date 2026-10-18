import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  ENVIRONMENT_NAME,
  GITHUB_HOST,
  GITHUB_SECRET,
  GITHUB_USERNAME,
  hasGithubCredentialRow,
  isGitHostCredential,
  normalizeGitHost,
  normalizeGitSecretName,
  normalizeGitUsername,
  type GitHostCredential,
} from "./git-hosts.js";

interface BrokerFile {
  version: 3;
  /** The global scope, delivered to every sandbox. */
  secrets: Record<string, string>;
  /** Per-workspace scopes, keyed by repository URL; same names override global. */
  workspaces: Record<string, Record<string, string>>;
  /** The hosts Git may ask about, and which secret answers each. */
  gitHosts: GitHostCredential[];
}

export interface BrokerOptions {
  path: string;
}

/**
 * Which secrets one operation reads or writes. The global scope reaches every
 * sandbox; a workspace scope reaches that workspace's sandboxes and overrides
 * a global secret of the same name. The union is deliberate: a missing scope
 * must not read as "global only".
 */
export type SecretScope =
  | { readonly kind: "global" }
  | { readonly kind: "workspace"; readonly repositoryUrl: string };

/** The global scope, for callers that are not addressing one workspace. */
export const GLOBAL_SECRET_SCOPE: SecretScope = { kind: "global" };

/** Durable authority stays on the host; only current values are pushed to a runner. */
export class CredentialBroker {
  private state: BrokerFile = {
    version: 3,
    secrets: {},
    workspaces: {},
    gitHosts: [],
  };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: BrokerOptions) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 });
    await this.refresh();
  }

  /** Pick up changes made by the companion CLI before the next command runs. */
  async refresh(): Promise<void> {
    await this.writeChain;
    try {
      this.state = parseBrokerFile(
        JSON.parse(await readFile(this.options.path, "utf8")),
      );
    } catch (error) {
      if (isNotFound(error)) {
        this.state = { version: 3, secrets: {}, workspaces: {}, gitHosts: [] };
      } else {
        throw error;
      }
    }
  }

  /**
   * The effective secrets one scope's sandbox receives: for a workspace, the
   * global set with the workspace's own names overriding it; for global, that
   * set alone.
   */
  secrets(scope: SecretScope): Record<string, string> {
    return scope.kind === "global"
      ? { ...this.state.secrets }
      : { ...this.state.secrets, ...this.stored(scope) };
  }

  /** Names stored in one scope, sorted; not the merged view. */
  secretNames(scope: SecretScope): string[] {
    return Object.keys(this.stored(scope)).sort();
  }

  /** Store one secret in a scope. */
  async setSecret(
    scope: SecretScope,
    name: string,
    value: string,
  ): Promise<void> {
    if (!ENVIRONMENT_NAME.test(name)) {
      throw new Error(`invalid environment variable name: ${name}`);
    }
    if (scope.kind === "global") {
      this.state.secrets[name] = value;
    } else {
      const key = workspaceKey(scope.repositoryUrl);
      const workspace = (this.state.workspaces[key] ??= {});
      workspace[name] = value;
    }
    await this.persist();
  }

  async deleteSecret(scope: SecretScope, name: string): Promise<void> {
    if (scope.kind === "global") {
      delete this.state.secrets[name];
    } else {
      const key = workspaceKey(scope.repositoryUrl);
      const workspace = this.state.workspaces[key];
      if (workspace === undefined) {
        return;
      }
      delete workspace[name];
      if (Object.keys(workspace).length === 0) {
        delete this.state.workspaces[key];
      }
    }
    await this.persist();
  }

  /** The configured Git hosts, in table order. */
  gitHosts(): GitHostCredential[] {
    return this.state.gitHosts.map((entry) => ({ ...entry }));
  }

  /** Add or replace the credential for one host. */
  async setGitHost(
    host: string,
    username: string,
    secret: string,
  ): Promise<void> {
    const entry: GitHostCredential = {
      host: normalizeGitHost(host),
      username: normalizeGitUsername(username),
      secret: normalizeGitSecretName(secret),
    };
    const index = this.state.gitHosts.findIndex(
      (existing) => existing.host === entry.host,
    );
    if (index === -1) {
      this.state.gitHosts.push(entry);
    } else {
      this.state.gitHosts[index] = entry;
    }
    await this.persist();
  }

  async deleteGitHost(host: string): Promise<void> {
    const normalized = normalizeGitHost(host);
    const index = this.state.gitHosts.findIndex(
      (existing) => existing.host === normalized,
    );
    if (index === -1) {
      return;
    }
    this.state.gitHosts.splice(index, 1);
    await this.persist();
  }

  /**
   * The credentials Git may ask for. A table row whose secret is present wins;
   * a row whose secret is absent is skipped. A row for github.com replaces the
   * built-in `GITHUB_TOKEN` entry even before its secret is set, so removing
   * the row is how a user falls back. A workspace-scoped secret serves that
   * workspace's clones, and the workspace's own host does not matter: a
   * session in any workspace may clone from any configured host.
   */
  async gitCredentials(
    repositoryUrl: string,
  ): Promise<Array<{ host: string; username: string; password: string }>> {
    // Read through the merge, so scope precedence has one definition.
    return this.resolvedGitCredentials({
      kind: "workspace",
      repositoryUrl,
    });
  }

  private resolvedGitCredentials(
    scope: SecretScope,
  ): Array<{ host: string; username: string; password: string }> {
    const secrets = this.secrets(scope);
    const credentials: Array<{
      host: string;
      username: string;
      password: string;
    }> = [];
    const hosts = new Set<string>();
    for (const entry of this.state.gitHosts) {
      if (hosts.has(entry.host)) {
        continue;
      }
      const password = secrets[entry.secret];
      if (password === undefined) {
        continue;
      }
      credentials.push({
        host: entry.host,
        username: entry.username,
        password,
      });
      hosts.add(entry.host);
    }
    const githubToken = secrets[GITHUB_SECRET];
    if (
      !hasGithubCredentialRow(this.state.gitHosts) &&
      githubToken !== undefined
    ) {
      credentials.push({
        host: GITHUB_HOST,
        username: GITHUB_USERNAME,
        password: githubToken,
      });
    }
    return credentials;
  }

  /** The names stored in one scope, before the global merge. */
  private stored(scope: SecretScope): Record<string, string> {
    return scope.kind === "global"
      ? this.state.secrets
      : (this.state.workspaces[workspaceKey(scope.repositoryUrl)] ?? {});
  }

  private persist(): Promise<void> {
    const snapshot = `${JSON.stringify(this.state, null, 2)}\n`;
    this.writeChain = this.writeChain.then(async () => {
      const temporary = `${this.options.path}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.options.path);
    });
    return this.writeChain;
  }
}

export function normalizeRepositoryUrl(url: string): string {
  const scpStyle = /^git@github\.com:(.+)$/.exec(url);
  if (scpStyle?.[1] !== undefined) {
    return `https://github.com/${scpStyle[1]}`;
  }
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol === "ssh:" &&
      parsed.hostname.toLowerCase() === "github.com"
    ) {
      return `https://github.com/${parsed.pathname.replace(/^\//, "")}`;
    }
  } catch {
    // Keep local paths and other Git URL forms unchanged.
  }
  return url;
}

/**
 * The canonical key for a workspace scope. Registered workspaces are keyed by
 * `normalizeWorkspaceRepositoryUrl` (workspace-anchor.ts), which is stricter
 * than a lookup should be, so this accepts the common clone-URL spellings of
 * one repository — a `.git` suffix, a trailing slash, a query, or a
 * differently-cased host must not create a second scope that silently
 * receives nothing.
 */
function workspaceKey(repositoryUrl: string): string {
  const normalized = normalizeRepositoryUrl(repositoryUrl.trim())
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  try {
    const parsed = new URL(normalized);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    // scp-style and local forms stay as they are.
    return normalized;
  }
}

function isSecretRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isWorkspaceScopeMap(
  value: unknown,
): value is Record<string, Record<string, string>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isSecretRecord)
  );
}

function parseGitHosts(value: unknown): GitHostCredential[] {
  if (!Array.isArray(value)) {
    throw new Error("credential broker file has an unsupported format");
  }
  const hosts = new Map<string, GitHostCredential>();
  for (const entry of value) {
    if (!isGitHostCredential(entry)) {
      throw new Error("credential broker file has an unsupported format");
    }
    try {
      const host = normalizeGitHost(entry.host);
      hosts.set(host, {
        host,
        username: normalizeGitUsername(entry.username),
        secret: normalizeGitSecretName(entry.secret),
      });
    } catch {
      throw new Error("credential broker file has an unsupported format");
    }
  }
  return [...hosts.values()];
}

function parseBrokerFile(value: unknown): BrokerFile {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    (value.version !== 1 && value.version !== 2 && value.version !== 3) ||
    !("secrets" in value) ||
    !isSecretRecord(value.secrets)
  ) {
    throw new Error("credential broker file has an unsupported format");
  }
  if (value.version === 1) {
    return {
      version: 3,
      secrets: value.secrets,
      workspaces: {},
      gitHosts: [],
    };
  }
  if (!("workspaces" in value) || !isWorkspaceScopeMap(value.workspaces)) {
    throw new Error("credential broker file has an unsupported format");
  }
  if (value.version === 2) {
    return {
      version: 3,
      secrets: value.secrets,
      workspaces: value.workspaces,
      gitHosts: [],
    };
  }
  if (!("gitHosts" in value)) {
    throw new Error("credential broker file has an unsupported format");
  }
  // Keep only the known fields so retired ones (like the removed device-flow
  // token) drop out of the file on the next write.
  return {
    version: 3,
    secrets: value.secrets,
    workspaces: value.workspaces,
    gitHosts: parseGitHosts(value.gitHosts),
  };
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
