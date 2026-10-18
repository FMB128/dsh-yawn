/**
 * OpenID Connect sign-in for the control plane.
 *
 * The authorization code flow runs in this process with PKCE, state, and a
 * nonce. Once the identity provider returns an accepted email, the row mints
 * dsh's browser cookie through dsh's own launch-token exchange, so the token
 * never reaches the browser and no oauth2-proxy sidecar is involved.
 *
 * Configuration comes from `DSH_YAWN_OIDC_*` (see the exported constants). At
 * least one of `ALLOWED_EMAILS` or `ALLOWED_DOMAINS` is required: this is a
 * single-owner control plane, so "anyone the IdP knows" is too broad.
 *
 * @module @zhming0/dsh-yawn/oidc-auth
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { Context } from "@deepseek-ai/cordis";
import * as oidc from "openid-client";

import {
  LOGIN_PATH,
  LOGOUT_PATH,
  hasLaunchToken,
  installHealth,
  installIndexGate,
  installLogout,
  loggedIn,
  mintDshCookie,
  redirect,
  sendText,
  untrusted,
} from "./auth-core.js";

export { LOGIN_PATH, LOGOUT_PATH, hasLaunchToken };

/** Authorization server issuer URL. */
export const ISSUER_ENV = "DSH_YAWN_OIDC_ISSUER";
/** Client identifier registered at the issuer. */
export const CLIENT_ID_ENV = "DSH_YAWN_OIDC_CLIENT_ID";
/** Optional client secret; public PKCE clients leave it unset. */
export const CLIENT_SECRET_ENV = "DSH_YAWN_OIDC_CLIENT_SECRET";
/** Exact redirect URL registered at the issuer. */
export const REDIRECT_URL_ENV = "DSH_YAWN_OIDC_REDIRECT_URL";
/** Comma-separated exact email allowlist. */
export const ALLOWED_EMAILS_ENV = "DSH_YAWN_OIDC_ALLOWED_EMAILS";
/** Comma-separated email-domain allowlist. */
export const ALLOWED_DOMAINS_ENV = "DSH_YAWN_OIDC_ALLOWED_DOMAINS";
/** Optional OIDC scope. Default: `openid email profile`. */
export const SCOPE_ENV = "DSH_YAWN_OIDC_SCOPE";
/** Set to `false` to require `email_verified: true`; default allows it to be false. */
export const ALLOW_UNVERIFIED_EMAIL_ENV =
  "DSH_YAWN_OIDC_ALLOW_UNVERIFIED_EMAIL";

const DEFAULT_SCOPE = "openid email profile";
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_STATES = 1024;

export type OidcLibrary = Pick<
  typeof oidc,
  | "discovery"
  | "buildAuthorizationUrl"
  | "authorizationCodeGrant"
  | "randomPKCECodeVerifier"
  | "calculatePKCECodeChallenge"
  | "randomState"
  | "randomNonce"
  | "allowInsecureRequests"
>;

export const name = "sandbox-oidc-auth";
export const inject = ["webServer", "connection"];

export interface OidcAuthConfig {
  issuer?: string | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  redirectUrl?: string | undefined;
  allowedEmails?: string[] | undefined;
  allowedDomains?: string[] | undefined;
  scope?: string | undefined;
  /** Default true: the IdP is trusted to assert the email address. */
  allowUnverifiedEmail?: boolean | undefined;
  /** Tests replace the network client. */
  library?: OidcLibrary | undefined;
}

interface PendingLogin {
  verifier: string;
  nonce: string;
  createdAt: number;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

function fromEnvironment(): OidcAuthConfig {
  return {
    issuer: process.env[ISSUER_ENV],
    clientId: process.env[CLIENT_ID_ENV],
    clientSecret: process.env[CLIENT_SECRET_ENV],
    redirectUrl: process.env[REDIRECT_URL_ENV],
    allowedEmails: list(process.env[ALLOWED_EMAILS_ENV]),
    allowedDomains: list(process.env[ALLOWED_DOMAINS_ENV]),
    scope: process.env[SCOPE_ENV],
    allowUnverifiedEmail: parseBoolean(
      process.env[ALLOW_UNVERIFIED_EMAIL_ENV],
      true,
    ),
  };
}

function parseBoolean(
  value: string | boolean | undefined,
  fallback: boolean,
): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === undefined || value === "") {
    return fallback;
  }
  return value !== "false";
}

function requireHttpUrl(name: string, value: string | undefined): URL {
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      `${name} must use https (http is allowed only on loopback)`,
    );
  }
  return url;
}

function resolved(config: OidcAuthConfig): {
  issuer: URL;
  clientId: string;
  clientSecret: string | undefined;
  redirectUrl: URL;
  allowedEmails: string[];
  allowedDomains: string[];
  scope: string;
  allowUnverifiedEmail: boolean;
} {
  const issuer = requireHttpUrl(ISSUER_ENV, config.issuer);
  const redirectUrl = requireHttpUrl(REDIRECT_URL_ENV, config.redirectUrl);
  const clientId = config.clientId?.trim() ?? "";
  if (clientId.length === 0) {
    throw new Error(`${CLIENT_ID_ENV} must be set`);
  }
  const allowedEmails = (config.allowedEmails ?? []).map((entry) =>
    entry.toLowerCase(),
  );
  const allowedDomains = (config.allowedDomains ?? []).map((entry) =>
    entry.toLowerCase(),
  );
  if (allowedEmails.length === 0 && allowedDomains.length === 0) {
    throw new Error(
      `${ALLOWED_EMAILS_ENV} or ${ALLOWED_DOMAINS_ENV} must allow at least one email or domain`,
    );
  }
  return {
    issuer,
    clientId,
    clientSecret:
      config.clientSecret === undefined || config.clientSecret === ""
        ? undefined
        : config.clientSecret,
    redirectUrl,
    allowedEmails,
    allowedDomains,
    scope: config.scope?.trim() || DEFAULT_SCOPE,
    allowUnverifiedEmail: config.allowUnverifiedEmail ?? true,
  };
}

/** Whether the ID-token claims name an allowed email under the verification policy. */
export function emailAllowed(
  claims: unknown,
  allowedEmails: readonly string[],
  allowedDomains: readonly string[],
  allowUnverifiedEmail = true,
): boolean {
  if (claims === null || typeof claims !== "object") {
    return false;
  }
  const record = claims as { email?: unknown; email_verified?: unknown };
  if (typeof record.email !== "string") {
    return false;
  }
  if (!allowUnverifiedEmail && record.email_verified !== true) {
    return false;
  }
  const email = record.email.toLowerCase();
  if (allowedEmails.includes(email)) {
    return true;
  }
  return allowedDomains.some((domain) => email.endsWith(`@${domain}`));
}

/** Bounded store for the PKCE verifier and nonce of a pending authorization. */
class PendingLogins {
  private readonly entries = new Map<string, PendingLogin>();

  remember(state: string, login: PendingLogin, now = Date.now()): void {
    this.prune(now);
    if (this.entries.size >= MAX_PENDING_STATES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
    this.entries.set(state, login);
  }

  take(state: string, now = Date.now()): PendingLogin | undefined {
    const login = this.entries.get(state);
    this.entries.delete(state);
    if (login === undefined || now - login.createdAt > STATE_TTL_MS) {
      return undefined;
    }
    return login;
  }

  private prune(now: number): void {
    for (const [state, login] of this.entries) {
      if (now - login.createdAt > STATE_TTL_MS) {
        this.entries.delete(state);
      }
    }
  }
}

function failure(response: ServerResponse, message: string): void {
  sendText(response, 401, `${message}\n`);
}

type OidcSettings = ReturnType<typeof resolved>;

/**
 * Add OIDC sign-in in front of dsh's browser authentication.
 */
export function apply(ctx: Context, config?: OidcAuthConfig): void {
  let settings: OidcSettings | undefined;
  try {
    settings = resolved(config ?? fromEnvironment());
  } catch (error) {
    // Keep the row active so the index gate still refuses dsh's token URL.
    // Login answers 503 until the deployment fixes its OIDC settings.
    ctx.logger.warn(
      `${name}: configuration is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const library = config?.library ?? oidc;
  const connection = ctx.connection;
  const authorizeIndex = connection.authorizeIndex.bind(connection);
  const pending = new PendingLogins();
  let configuration:
    | Promise<Awaited<ReturnType<typeof oidc.discovery>>>
    | undefined;

  function configurationFor(
    current: OidcSettings,
  ): Promise<Awaited<ReturnType<typeof oidc.discovery>>> {
    configuration ??= library
      .discovery(
        current.issuer,
        current.clientId,
        current.clientSecret,
        undefined,
        current.issuer.protocol === "http:"
          ? { execute: [library.allowInsecureRequests] }
          : undefined,
      )
      .catch((error: unknown) => {
        configuration = undefined;
        throw error;
      });
    return configuration;
  }

  async function handleLogin(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (untrusted(connection, request, response)) {
      return;
    }
    if (loggedIn(connection, request)) {
      redirect(response, "/");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendText(response, 405, "method not allowed\n", { allow: "GET, HEAD" });
      return;
    }
    if (settings === undefined) {
      sendText(response, 503, "sign-in is unavailable\n");
      return;
    }
    const current = settings;
    try {
      const configuration = await configurationFor(current);
      const verifier = library.randomPKCECodeVerifier();
      const challenge = await library.calculatePKCECodeChallenge(verifier);
      const state = library.randomState();
      const nonce = library.randomNonce();
      pending.remember(state, { verifier, nonce, createdAt: Date.now() });
      const target = library.buildAuthorizationUrl(configuration, {
        redirect_uri: current.redirectUrl.href,
        scope: current.scope,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        nonce,
      });
      redirect(response, target.href);
    } catch (error) {
      ctx.logger.warn(
        `${name}: could not start sign-in: ${error instanceof Error ? error.message : String(error)}`,
      );
      sendText(response, 503, "sign-in is unavailable\n");
    }
  }

  async function handleCallback(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (untrusted(connection, request, response)) {
      return;
    }
    if (request.method !== "GET") {
      sendText(response, 405, "method not allowed\n", { allow: "GET" });
      return;
    }
    if (settings === undefined) {
      sendText(response, 503, "sign-in is unavailable\n");
      return;
    }
    let current: URL;
    try {
      current = new URL(request.url ?? "/", settings.redirectUrl);
    } catch {
      failure(response, "sign-in failed");
      return;
    }
    const state = current.searchParams.get("state");
    if (state === null) {
      failure(response, "sign-in failed");
      return;
    }
    const login = pending.take(state);
    if (login === undefined) {
      failure(response, "sign-in expired; try again");
      return;
    }
    try {
      const configuration = await configurationFor(settings);
      const tokens = await library.authorizationCodeGrant(
        configuration,
        current,
        {
          pkceCodeVerifier: login.verifier,
          expectedState: state,
          expectedNonce: login.nonce,
        },
      );
      const claims = tokens.claims();
      if (
        !emailAllowed(
          claims,
          settings.allowedEmails,
          settings.allowedDomains,
          settings.allowUnverifiedEmail,
        )
      ) {
        failure(response, "this account is not allowed");
        return;
      }
      const cookie = mintDshCookie(connection, authorizeIndex, request);
      if (cookie === undefined) {
        sendText(response, 500, "sign-in failed\n");
        return;
      }
      redirect(response, "/", { "set-cookie": cookie });
    } catch (error) {
      ctx.logger.warn(
        `${name}: callback failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      failure(response, "sign-in failed");
    }
  }

  installIndexGate(ctx, LOGIN_PATH, authorizeIndex);
  installHealth(ctx, () => settings !== undefined);

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: LOGIN_PATH,
        handler: (request, response) => handleLogin(request, response),
      }),
    `${name}: ${LOGIN_PATH} route`,
  );

  if (settings !== undefined) {
    const callbackPath = settings.redirectUrl.pathname;
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: "exact",
          path: callbackPath,
          handler: (request, response) => handleCallback(request, response),
        }),
      `${name}: ${callbackPath} route`,
    );
  }

  installLogout(ctx, LOGIN_PATH, authorizeIndex);
}
