/**
 * The explicit Git credential table. A host names the secret that holds its
 * password and the username Git sends; nothing is inferred from a secret's
 * name, so a token that is not a Git credential is never treated as one.
 *
 * Shared by the host (which serves the credentials) and the settings page
 * (which edits the table), so both agree on the rules without the wire
 * carrying derived fields.
 */
export interface GitHostCredential {
  host: string;
  username: string;
  secret: string;
}

/** The username most token-based forges accept; each row can change it. */
export const DEFAULT_GIT_USERNAME = "oauth2";

/**
 * The built-in github.com credential, which needs no table row. A table row
 * for github.com replaces it, even before the row's secret is set.
 */
export const GITHUB_HOST = "github.com";
export const GITHUB_USERNAME = "x-access-token";
export const GITHUB_SECRET = "GITHUB_TOKEN";

/** The broker's environment-name rule, shared with the secret name field. */
export const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const HOST_WITH_PORT = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/i;

/**
 * The host Git sends to the credential helper: a hostname, optionally with a
 * port, lower-cased. A scheme, path, or credentials are rejected because the
 * helper matches the host exactly. A single label (`localhost`) is allowed;
 * an IPv6 literal is not.
 */
export function normalizeGitHost(input: string): string {
  const host = input.trim().toLowerCase();
  const match = HOST_WITH_PORT.exec(host);
  if (match === null) {
    throw new Error("Enter a host name, optionally with a port");
  }
  const hostname = match[1]!;
  if (!hostname.split(".").every((label) => HOST_LABEL.test(label))) {
    throw new Error("Enter a host name, optionally with a port");
  }
  const port = match[2];
  if (port === undefined) {
    return hostname;
  }
  const value = Number(port);
  if (value < 1 || value > 65535) {
    throw new Error("Enter a port between 1 and 65535");
  }
  // Git omits the default HTTPS port from the credential host, so a row for
  // :443 would never match; store it without the port. Other ports are
  // serialized without leading zeros.
  return value === 443 ? hostname : `${hostname}:${value}`;
}

/** The username Git sends; it may not break the credential-helper protocol. */
export function normalizeGitUsername(input: string): string {
  const username = input.trim();
  if (username === "" || /[\r\n]/.test(username)) {
    throw new Error("Enter a username");
  }
  return username;
}

/** The secret that supplies the password. It is an environment name. */
export function normalizeGitSecretName(input: string): string {
  const name = input.trim();
  if (!ENVIRONMENT_NAME.test(name)) {
    throw new Error("Enter a secret name: letters, digits, and underscores");
  }
  return name;
}

/** Whether the table names github.com, which replaces the built-in row. */
export function hasGithubCredentialRow(
  rows: readonly GitHostCredential[],
): boolean {
  return rows.some((entry) => entry.host === GITHUB_HOST);
}

/** The hosts a secret name supplies, including the built-in github.com row. */
export function gitHostsForSecret(
  rows: readonly GitHostCredential[],
  name: string,
): string[] {
  const hosts = rows
    .filter((entry) => entry.secret === name)
    .map((entry) => entry.host);
  if (name === GITHUB_SECRET && !hasGithubCredentialRow(rows)) {
    hosts.unshift(GITHUB_HOST);
  }
  return hosts;
}

export function isGitHostCredential(
  value: unknown,
): value is GitHostCredential {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "host" in value &&
    typeof value.host === "string" &&
    value.host.length > 0 &&
    "username" in value &&
    typeof value.username === "string" &&
    value.username.length > 0 &&
    "secret" in value &&
    typeof value.secret === "string" &&
    value.secret.length > 0
  );
}
