import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { normalizeRepositoryUrl } from "./broker.js";

const ANCHORS_DIRECTORY = "workspace-anchors";
const METADATA_FILE = "repository.json";

interface AnchorMetadata {
  version: 1;
  repositoryUrl: string;
}

export interface RepositoryAnchor {
  path: string;
  repositoryUrl: string;
  title: string;
}

/** Create the stable host directory dsh uses as one repository's Workspace. */
export async function createRepositoryAnchor(
  stateDir: string,
  input: string,
): Promise<RepositoryAnchor> {
  const repositoryUrl = normalizeWorkspaceRepositoryUrl(
    httpsRepositoryUrl(input),
  );
  const title = repositoryTitle(repositoryUrl);
  const root = anchorRoot(stateDir);
  const path = anchorPath(stateDir, repositoryUrl, title);

  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);

  const metadata: AnchorMetadata = { version: 1, repositoryUrl };
  const metadataPath = join(path, METADATA_FILE);
  let existing: AnchorMetadata;
  try {
    existing = await readAnchorMetadata(metadataPath);
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
    const temporary = `${metadataPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temporary, metadataPath);
    } finally {
      await rm(temporary, { force: true });
    }
    existing = await readAnchorMetadata(metadataPath);
  }
  if (existing.repositoryUrl !== repositoryUrl) {
    throw new Error("repository anchor hash collision");
  }
  await chmod(metadataPath, 0o600);

  return { path: await realpath(path), repositoryUrl, title };
}

/** Resolve repository metadata only for a control-plane-managed anchor directory. */
export async function repositoryForAnchor(
  stateDir: string,
  cwd: string,
): Promise<string | undefined> {
  let root: string;
  let path: string;
  try {
    [root, path] = await Promise.all([
      realpath(anchorRoot(stateDir)),
      realpath(cwd),
    ]);
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }

  const child = relative(root, path);
  if (child.length === 0 || child.startsWith("..") || isAbsolute(child)) {
    return undefined;
  }
  if (child.includes("/") || child.includes("\\")) {
    return undefined;
  }

  let metadata: AnchorMetadata;
  try {
    metadata = await readAnchorMetadata(join(path, METADATA_FILE));
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }

  const expected = await realpath(
    anchorPath(
      stateDir,
      metadata.repositoryUrl,
      repositoryTitle(metadata.repositoryUrl),
    ),
  );
  if (expected !== path) {
    throw new Error("repository anchor metadata is invalid");
  }
  return metadata.repositoryUrl;
}

/** One settings scope beyond global: a registered repository workspace. */
export interface WorkspaceScope {
  repositoryUrl: string;
  title: string;
}

/**
 * The scopes settings pages offer: every registry workspace that resolves to a
 * repository anchor, in registry order. Entries the anchor store cannot
 * resolve are skipped, so an unrelated directory never becomes a scope.
 */
export async function workspaceScopes(
  stateDir: string,
  workspaces: Array<{ path: string; title: string }>,
): Promise<WorkspaceScope[]> {
  const scopes = await Promise.all(
    workspaces.map(async (workspace) => {
      const repositoryUrl = await repositoryForAnchor(stateDir, workspace.path);
      return repositoryUrl === undefined
        ? undefined
        : { repositoryUrl, title: workspace.title };
    }),
  );
  return scopes.filter((scope): scope is WorkspaceScope => scope !== undefined);
}

interface ScpRepositoryUrl {
  user: string;
  host: string;
  path: string;
}

function parseScpRepositoryUrl(input: string): ScpRepositoryUrl | undefined {
  const match = /^([^@/:]+)@([^/:]+):(.+)$/.exec(input);
  return match === null
    ? undefined
    : { user: match[1]!, host: match[2]!, path: match[3]! };
}

/**
 * Normalize and validate a repository URL. New Workspaces run
 * httpsRepositoryUrl first, so this also accepts the SSH, HTTP, and git forms
 * that older anchors stored.
 */
export function normalizeWorkspaceRepositoryUrl(input: string): string {
  let repositoryUrl = normalizeRepositoryUrl(input.trim());
  if (repositoryUrl.length === 0 || /\s/.test(repositoryUrl)) {
    throw new Error("Enter a repository URL");
  }

  const scp = parseScpRepositoryUrl(repositoryUrl);
  if (scp !== undefined) {
    if (scp.path.includes("?") || scp.path.includes("#")) {
      throw new Error("Repository URL must not contain a query or fragment");
    }
    const path = normalizeRepositoryPath(scp.path);
    if (path.length === 0) {
      throw new Error("Repository URL has no path");
    }
    return `${scp.user}@${scp.host.toLowerCase()}:${path}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(repositoryUrl);
  } catch {
    throw new Error("Enter a valid repository URL");
  }
  if (!["http:", "https:", "ssh:", "git:"].includes(parsed.protocol)) {
    throw new Error(
      "Use an HTTPS repository URL (an SSH URL without a port is converted)",
    );
  }
  if (parsed.password.length > 0) {
    throw new Error("Repository URL must not contain a password");
  }
  if (
    parsed.username.length > 0 &&
    ["http:", "https:", "git:"].includes(parsed.protocol)
  ) {
    throw new Error("Repository URL must not contain credentials");
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error("Repository URL must not contain a query or fragment");
  }
  const path = normalizeRepositoryPath(parsed.pathname);
  if (path.length === 0) {
    throw new Error("Repository URL has no path");
  }
  parsed.pathname = `/${path}`;
  repositoryUrl = parsed.toString();
  return repositoryUrl.endsWith("/")
    ? repositoryUrl.slice(0, -1)
    : repositoryUrl;
}

/**
 * New Workspaces clone over HTTPS. Convert an SSH clone URL to its HTTPS
 * form; an explicit SSH port is ambiguous because it is the SSH port, a URL
 * with a password is rejected, and `git://`/HTTP are not HTTPS. Other URLs
 * pass through for normalizeWorkspaceRepositoryUrl to validate.
 */
export function httpsRepositoryUrl(input: string): string {
  const trimmed = input.trim();
  const scp = parseScpRepositoryUrl(trimmed);
  if (scp !== undefined) {
    return `https://${scp.host.toLowerCase()}/${scp.path.replace(/^\/+/, "")}`;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return input;
  }
  if (url.protocol === "ssh:") {
    if (url.password !== "") {
      throw new Error("Repository URL must not contain a password");
    }
    if (url.port !== "") {
      throw new Error(
        "Use the HTTPS repository URL; an SSH URL with a port is ambiguous",
      );
    }
    return `https://${url.host}${url.pathname}${url.search}${url.hash}`;
  }
  if (url.protocol === "git:") {
    throw new Error("Use the HTTPS repository URL; git:// is not supported");
  }
  if (url.protocol === "http:") {
    throw new Error("Use the HTTPS repository URL; HTTP is not supported");
  }
  return input;
}

export function repositoryTitle(repositoryUrl: string): string {
  let path: string;
  try {
    path = new URL(repositoryUrl).pathname;
  } catch {
    path = /^[^@]+@[^:]+:(.+)$/.exec(repositoryUrl)?.[1] ?? repositoryUrl;
  }
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const repository = parts.at(-1) ?? repositoryUrl;
  const owner = parts.at(-2);
  return owner === undefined ? repository : `${owner}/${repository}`;
}

function anchorRoot(stateDir: string): string {
  return resolve(stateDir, ANCHORS_DIRECTORY);
}

function anchorPath(
  stateDir: string,
  repositoryUrl: string,
  title: string,
): string {
  let host = "repository";
  try {
    host = new URL(repositoryUrl).hostname;
  } catch {
    host = /^[^@]+@([^:]+):/.exec(repositoryUrl)?.[1] ?? host;
  }
  const slug = `${host}-${title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  const hash = createHash("sha256")
    .update(repositoryUrl)
    .digest("hex")
    .slice(0, 32);
  return join(anchorRoot(stateDir), `${slug || "repository"}-${hash}`);
}

function normalizeRepositoryPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
}

async function readAnchorMetadata(path: string): Promise<AnchorMetadata> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("repositoryUrl" in value) ||
    typeof value.repositoryUrl !== "string" ||
    normalizeWorkspaceRepositoryUrl(value.repositoryUrl) !== value.repositoryUrl
  ) {
    throw new Error("repository anchor metadata has an unsupported format");
  }
  return value as AnchorMetadata;
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
