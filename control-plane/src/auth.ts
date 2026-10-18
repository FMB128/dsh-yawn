/**
 * Built-in OIDC sign-in for the control plane.
 *
 * The distribution used to put oauth2-proxy in front of dsh and expose
 * `GET /launch-token` so a proxied user could exchange dsh's per-process token
 * for its browser cookie. This row replaces that deployment shape: the control
 * plane runs the authorization-code flow itself, stores the result in its own
 * signed session cookie, and admits the browser and its API/WebSocket traffic
 * from that cookie. dsh's launch token stays in the process, but a deployment
 * with this row mounted neither prints it nor exchanges it.
 *
 * The row is mounted only when the `DSH_YAWN_OIDC_*` environment names a
 * provider. Without them it does nothing, so a port-forward install keeps
 * dsh's own launch-token exchange (and the image's optional `/launch-token`
 * row) as before.
 *
 * Identity is one trust domain, not multi-user isolation: every authenticated
 * person shares the control plane's sessions, secrets, and sandboxes. The
 * email-domain allowlist limits who is admitted; it does not separate them.
 *
 * @module @zhming0/dsh-yawn/auth
 */

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { symbols, type Context } from "@deepseek-ai/cordis";
import {
  credentialKey,
  type CredentialProvider,
  type CredentialRecord,
} from "@deepseek-ai/dsh-credentials";
import type {
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionTrustRequest,
  HostConnectionHandle,
  PeerAdmission,
} from "@deepseek-ai/dsh-client-connection";
import type {} from "@deepseek-ai/dsh-host-webserver";
import * as oidc from "openid-client";

/** Where the browser starts a sign-in. */
export const AUTH_LOGIN_PATH = "/dsh-yawn/auth/login";
/** The registered redirect URI's path. */
export const AUTH_CALLBACK_PATH = "/dsh-yawn/auth/callback";
/** Ends the local session; the identity provider is not contacted. */
export const AUTH_LOGOUT_PATH = "/dsh-yawn/auth/logout";
/** Unauthenticated liveness route for the pod readiness probe. */
export const AUTH_HEALTH_PATH = "/dsh-yawn/auth/health";

const DAY_MS = 86_400_000;
const PENDING_TTL_MS = 10 * 60_000;
const PENDING_LIMIT = 1024;
const SESSION_VERSION = 1;
const SESSION_COOKIE_PREFIX = "dsh-yawn-auth-";
const SESSION_STATE_COOKIE = "dsh-yawn-auth-state";
const STATE_MAX_AGE_SECONDS = 600;
const SESSION_SECRET_KEY = credentialKey("sandbox-auth", "session-secret");

/** Environment names a deployment uses to configure built-in sign-in. */
export const AUTH_ENV = {
  issuer: "DSH_YAWN_OIDC_ISSUER",
  clientId: "DSH_YAWN_OIDC_CLIENT_ID",
  clientSecret: "DSH_YAWN_OIDC_CLIENT_SECRET",
  redirectUrl: "DSH_YAWN_OIDC_REDIRECT_URL",
  emailDomains: "DSH_YAWN_OIDC_EMAIL_DOMAINS",
  scopes: "DSH_YAWN_OIDC_SCOPES",
  cookieMaxAgeDays: "DSH_YAWN_OIDC_COOKIE_MAX_AGE_DAYS",
  cookieSecure: "DSH_YAWN_OIDC_COOKIE_SECURE",
  clientAuthMethod: "DSH_YAWN_OIDC_CLIENT_AUTH_METHOD",
  allowInsecure: "DSH_YAWN_OIDC_ALLOW_INSECURE",
} as const;

export type ClientAuthMethod =
  | "client_secret_post"
  | "client_secret_basic"
  | "none";

export interface AuthConfig {
  readonly issuer: URL;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly redirectUrl: URL;
  /** Exact email domains; `*` admits any email. */
  readonly emailDomains: readonly string[];
  readonly scopes: string;
  readonly cookieMaxAgeDays: number;
  readonly secureCookies: boolean;
  readonly clientAuthMethod: ClientAuthMethod;
  /** Development only: permits an http issuer and redirect URI. */
  readonly allowInsecureRequests: boolean;
}

export interface OidcIdentity {
  readonly subject: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly name?: string;
}

/** The two protocol steps this row needs; tests replace the implementation. */
export interface OidcFlow {
  authorizationUrl(input: {
    state: string;
    nonce: string;
    codeChallenge: string;
  }): Promise<string>;
  exchange(input: {
    currentUrl: URL;
    state: string;
    nonce: string;
    codeVerifier: string;
  }): Promise<OidcIdentity>;
}

interface PendingSignIn {
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly createdAt: number;
}

interface SessionPayload {
  readonly version: typeof SESSION_VERSION;
  readonly authority: string;
  readonly subject: string;
  readonly email?: string;
  readonly name?: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export const name = "sandbox-auth";
export const inject = ["webServer", "connection", "credentials"];

/**
 * Read the provider configuration. Absent names mean built-in auth is off;
 * a partial configuration fails boot instead of silently leaving the UI open.
 * @param env - process environment, injectable for tests.
 * @returns the parsed configuration, or undefined when auth is not configured.
 */
export function readAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): AuthConfig | undefined {
  const issuer = value(env, AUTH_ENV.issuer);
  const clientId = value(env, AUTH_ENV.clientId);
  const redirectUrl = value(env, AUTH_ENV.redirectUrl);
  if (
    issuer === undefined &&
    clientId === undefined &&
    redirectUrl === undefined
  ) {
    return undefined;
  }
  if (
    issuer === undefined ||
    clientId === undefined ||
    redirectUrl === undefined
  ) {
    throw new Error(
      `dsh-yawn auth: ${AUTH_ENV.issuer}, ${AUTH_ENV.clientId}, and ${AUTH_ENV.redirectUrl} must be set together`,
    );
  }
  const allowInsecureRequests = booleanValue(env, AUTH_ENV.allowInsecure);
  const issuerUrl = urlValue(AUTH_ENV.issuer, issuer, allowInsecureRequests);
  const redirect = urlValue(
    AUTH_ENV.redirectUrl,
    redirectUrl,
    allowInsecureRequests,
  );
  if (redirect.pathname !== AUTH_CALLBACK_PATH) {
    throw new Error(
      `dsh-yawn auth: ${AUTH_ENV.redirectUrl} must end at ${AUTH_CALLBACK_PATH}, got ${JSON.stringify(redirect.pathname)}`,
    );
  }
  if (redirect.search !== "" || redirect.hash !== "") {
    throw new Error(
      `dsh-yawn auth: ${AUTH_ENV.redirectUrl} must not carry a query or fragment`,
    );
  }
  const rawDomains = value(env, AUTH_ENV.emailDomains) ?? "*";
  const emailDomains = rawDomains
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain !== "");
  if (emailDomains.length === 0) {
    throw new Error(
      `dsh-yawn auth: ${AUTH_ENV.emailDomains} must name at least one domain, or *`,
    );
  }
  const scopes = value(env, AUTH_ENV.scopes) ?? "openid email profile";
  if (!scopes.split(/\s+/).includes("openid")) {
    throw new Error(
      `dsh-yawn auth: ${AUTH_ENV.scopes} must include the openid scope`,
    );
  }
  const cookieMaxAgeDays = integerValue(
    env,
    AUTH_ENV.cookieMaxAgeDays,
    30,
    1,
    365,
  );
  const secureCookies =
    optionalBooleanValue(env, AUTH_ENV.cookieSecure) ??
    redirect.protocol === "https:";
  const clientSecret = value(env, AUTH_ENV.clientSecret);
  const clientAuthMethod = clientAuthMethodValue(env, clientSecret);
  return {
    issuer: issuerUrl,
    clientId,
    redirectUrl: redirect,
    emailDomains,
    scopes,
    cookieMaxAgeDays,
    secureCookies,
    clientAuthMethod,
    allowInsecureRequests,
    ...(clientSecret === undefined ? {} : { clientSecret }),
  };
}

/**
 * The openid-client-backed authorization-code flow with PKCE. Discovery is
 * lazy so a control plane can boot while its identity provider is temporarily
 * unreachable; the first login retries and the failure reaches that request.
 */
export class OpenIdFlow implements OidcFlow {
  private configuration: Promise<oidc.Configuration> | undefined;

  constructor(private readonly config: AuthConfig) {}

  async authorizationUrl(input: {
    state: string;
    nonce: string;
    codeChallenge: string;
  }): Promise<string> {
    const configuration = await this.configurationForIssuer();
    return oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: this.config.redirectUrl.href,
      scope: this.config.scopes,
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
    }).href;
  }

  async exchange(input: {
    currentUrl: URL;
    state: string;
    nonce: string;
    codeVerifier: string;
  }): Promise<OidcIdentity> {
    const configuration = await this.configurationForIssuer();
    const tokens = await oidc.authorizationCodeGrant(
      configuration,
      input.currentUrl,
      {
        expectedState: input.state,
        expectedNonce: input.nonce,
        pkceCodeVerifier: input.codeVerifier,
        idTokenExpected: true,
      },
    );
    const claims = tokens.claims();
    if (claims === undefined || typeof claims.sub !== "string") {
      throw new Error("the identity provider returned no subject");
    }
    return {
      subject: claims.sub,
      ...(typeof claims.email === "string" ? { email: claims.email } : {}),
      ...(typeof claims.email_verified === "boolean"
        ? { emailVerified: claims.email_verified }
        : {}),
      ...(typeof claims.name === "string" ? { name: claims.name } : {}),
    };
  }

  private configurationForIssuer(): Promise<oidc.Configuration> {
    if (this.configuration === undefined) {
      const clientAuthentication =
        this.config.clientAuthMethod === "client_secret_basic"
          ? oidc.ClientSecretBasic(this.config.clientSecret)
          : this.config.clientAuthMethod === "client_secret_post"
            ? oidc.ClientSecretPost(this.config.clientSecret)
            : oidc.None();
      const discovery = oidc.discovery(
        this.config.issuer,
        this.config.clientId,
        undefined,
        clientAuthentication,
        {
          timeout: 15,
          ...(this.config.allowInsecureRequests
            ? { execute: [oidc.allowInsecureRequests] }
            : {}),
        },
      );
      this.configuration = discovery;
      discovery.catch(() => {
        if (this.configuration === discovery) {
          this.configuration = undefined;
        }
      });
    }
    return this.configuration;
  }
}

/** A signed browser-session cookie tied to the authority the browser used. */
export class SessionCodec {
  constructor(
    private readonly secret: Buffer,
    private readonly maxAgeMilliseconds: number,
    private readonly secure: boolean,
    private readonly now: () => number = Date.now,
  ) {}

  /** The authority-bound cookie name for this request. */
  cookieName(authority: string): string {
    return (
      SESSION_COOKIE_PREFIX +
      createHash("sha256").update(authority).digest("base64url")
    );
  }

  /**
   * Verify one request's session cookie.
   * @param request - request headers carrying Host and Cookie.
   * @returns the signed payload, or undefined when absent, expired, or invalid.
   */
  read(request: ConnectionTrustRequest): SessionPayload | undefined {
    const authority = requestAuthority(request);
    if (authority === undefined) {
      return undefined;
    }
    const raw = header(request.headers, "cookie");
    if (raw === undefined) {
      return undefined;
    }
    const value = cookieValue(raw, this.cookieName(authority));
    if (value === undefined) {
      return undefined;
    }
    const payload = decodeSession(value, this.secret);
    if (
      payload === undefined ||
      payload.authority !== authority ||
      payload.expiresAt <= this.now() ||
      payload.expiresAt <= payload.issuedAt ||
      payload.expiresAt - payload.issuedAt > this.maxAgeMilliseconds ||
      payload.issuedAt > this.now() + 60_000
    ) {
      return undefined;
    }
    return payload;
  }

  /**
   * Mint the session cookie for an authenticated identity.
   * @param request - request whose Host scopes the cookie.
   * @param identity - claims the provider admitted.
   */
  issue(
    request: ConnectionTrustRequest,
    identity: OidcIdentity,
  ): { name: string; header: string } {
    const authority = requestAuthority(request);
    if (authority === undefined) {
      throw new Error("dsh-yawn auth: the request has no Host authority");
    }
    const issuedAt = this.now();
    const expiresAt = issuedAt + this.maxAgeMilliseconds;
    const payload: SessionPayload = {
      version: SESSION_VERSION,
      authority,
      subject: identity.subject,
      ...(identity.email === undefined ? {} : { email: identity.email }),
      ...(identity.name === undefined ? {} : { name: identity.name }),
      issuedAt,
      expiresAt,
    };
    const body = base64Url(Buffer.from(JSON.stringify(payload), "utf8"));
    const signature = base64Url(
      createHmac("sha256", this.secret).update(body).digest(),
    );
    const name = this.cookieName(authority);
    const attributes = `${name}=v${SESSION_VERSION}.${body}.${signature}; Max-Age=${String(Math.floor(this.maxAgeMilliseconds / 1000))}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Lax`;
    return {
      name,
      header: this.secure ? `${attributes}; Secure` : attributes,
    };
  }

  /** The short-lived cookie that binds one sign-in attempt to this browser. */
  stateCookie(state: string): string {
    const attributes = `${SESSION_STATE_COOKIE}=${state}; Max-Age=${String(STATE_MAX_AGE_SECONDS)}; Path=/; HttpOnly; SameSite=Lax`;
    return this.secure ? `${attributes}; Secure` : attributes;
  }

  /** The expired cookie that removes this request's session. */
  clear(request: ConnectionTrustRequest): string | undefined {
    const authority = requestAuthority(request);
    if (authority === undefined) {
      return undefined;
    }
    const name = this.cookieName(authority);
    const attributes = `${name}=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax`;
    return this.secure ? `${attributes}; Secure` : attributes;
  }
}

/** The route and admission behavior once a provider is configured. */
export class BuiltInAuth {
  private readonly pending = new Map<string, PendingSignIn>();

  constructor(
    private readonly config: AuthConfig,
    private readonly session: SessionCodec,
    private readonly flow: OidcFlow,
    private readonly warn: (message: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether this request carries a valid session cookie. */
  isSignedIn(request: ConnectionTrustRequest): boolean {
    return this.session.read(request) !== undefined;
  }

  /** Redirect to the identity provider. */
  async login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "GET") {
      writeMethodNotAllowed(res);
      return;
    }
    this.prunePending();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    let authorizationUrl: string;
    try {
      authorizationUrl = await this.flow.authorizationUrl({
        state,
        nonce,
        codeChallenge,
      });
    } catch (error) {
      this.warn(`dsh-yawn auth: cannot start sign-in: ${describe(error)}`);
      writeUnavailable(res);
      return;
    }
    this.pending.set(state, {
      nonce,
      codeVerifier,
      createdAt: this.now(),
    });
    res.writeHead(303, {
      location: authorizationUrl,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "set-cookie": this.session.stateCookie(state),
    });
    res.end();
  }

  /** Finish the authorization-code flow and mint the session cookie. */
  async callback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "GET") {
      writeMethodNotAllowed(res);
      return;
    }
    const currentUrl = new URL(req.url ?? "/", this.config.redirectUrl);
    const states = currentUrl.searchParams.getAll("state");
    const state = states.length === 1 ? states[0] : undefined;
    const pending = state === undefined ? undefined : this.pending.get(state);
    if (state === undefined || pending === undefined) {
      writeBadRequest(res, "sign-in state is missing or expired");
      return;
    }
    const stateCookie = cookieValue(
      header(req.headers, "cookie") ?? "",
      SESSION_STATE_COOKIE,
    );
    if (stateCookie !== state) {
      this.pending.delete(state);
      writeBadRequest(res, "sign-in state does not belong to this browser");
      return;
    }
    this.pending.delete(state);
    if (this.now() - pending.createdAt > PENDING_TTL_MS) {
      writeBadRequest(res, "sign-in state is missing or expired");
      return;
    }
    const providerError = currentUrl.searchParams.get("error");
    if (providerError !== null) {
      this.warn(
        `dsh-yawn auth: identity provider returned ${providerError}: ${currentUrl.searchParams.get("error_description") ?? ""}`,
      );
      writeBadRequest(res, "sign-in was not completed");
      return;
    }
    let identity: OidcIdentity;
    try {
      identity = await this.flow.exchange({
        currentUrl,
        state,
        nonce: pending.nonce,
        codeVerifier: pending.codeVerifier,
      });
    } catch (error) {
      this.warn(`dsh-yawn auth: token exchange failed: ${describe(error)}`);
      writeBadRequest(res, "sign-in could not be verified");
      return;
    }
    if (!admits(this.config, identity)) {
      this.warn(
        `dsh-yawn auth: refused ${identity.email ?? identity.subject}: not in an allowed email domain`,
      );
      writeForbidden(res);
      return;
    }
    const cookie = this.session.issue(req, identity);
    res.writeHead(303, {
      location: "/",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "set-cookie": cookie.header,
    });
    res.end();
  }

  /** Remove this browser's session. */
  logout(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "GET" && req.method !== "HEAD") {
      writeMethodNotAllowed(res);
      return;
    }
    const cookie = this.session.clear(req);
    res.writeHead(303, {
      location: "/",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      ...(cookie === undefined ? {} : { "set-cookie": cookie }),
    });
    res.end();
  }

  /** Unauthenticated liveness answer for the readiness probe. */
  health(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "GET" && req.method !== "HEAD") {
      writeMethodNotAllowed(res);
      return;
    }
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : "ok\n");
  }

  /**
   * Replace dsh's browser authentication with the session cookie. Every
   * wrapper is an own property on the live connection instance, so disposing
   * this row restores the stock methods.
   */
  wrap(connection: HostConnectionHandle): () => void {
    const isSignedIn = (request: ConnectionTrustRequest): boolean =>
      this.isSignedIn(request);
    const stockAdmit: Admit = Reflect.get(connection, "admit");
    const wrappedAdmit: Admit = function (request) {
      const admission = stockAdmit.call(this, request);
      if ("rejection" in admission && admission.rejection === 403) {
        return admission;
      }
      if (isSignedIn(request)) {
        return { peer: this.browserPeer };
      }
      // A legacy dsh cookie or /connect token must not bypass this sign-in.
      return { rejection: 401 };
    };

    const wrappedIndex: AuthorizeIndex = function (request, response) {
      if (isSignedIn(request)) {
        return true;
      }
      response.writeHead(303, {
        location: AUTH_LOGIN_PATH,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      response.end();
      return false;
    };

    const wrappedConnect: AuthorizeConnect = function (_request, response) {
      response.writeHead(401, { "cache-control": "no-store" });
      response.end("unauthorized");
    };

    const wrappedAuthenticatedUrl: AuthenticatedUrl = function (baseUrl) {
      return baseUrl;
    };

    const installed: Array<[string, unknown]> = [
      ["admit", wrappedAdmit],
      ["authorizeIndex", wrappedIndex],
      ["authorizeConnect", wrappedConnect],
      ["authenticatedUrl", wrappedAuthenticatedUrl],
    ];
    for (const [method, value] of installed) {
      Object.defineProperty(connection, method, {
        configurable: true,
        writable: true,
        value,
      });
    }
    return () => {
      for (const [method] of installed) {
        Reflect.deleteProperty(connection, method);
      }
    };
  }

  private prunePending(): void {
    const cutoff = this.now() - PENDING_TTL_MS;
    for (const [state, pending] of this.pending) {
      if (pending.createdAt < cutoff) {
        this.pending.delete(state);
      }
    }
    if (this.pending.size >= PENDING_LIMIT) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) {
        this.pending.delete(oldest);
      }
    }
  }
}

type Admit = (
  this: HostConnectionHandle,
  request: ConnectionTrustRequest,
) => PeerAdmission;

type AuthorizeIndex = (
  this: HostConnectionHandle,
  request: ConnectionIndexRequest,
  response: ConnectionIndexResponse,
) => boolean;

type AuthorizeConnect = (
  this: HostConnectionHandle,
  request: ConnectionIndexRequest,
  response: ConnectionIndexResponse,
) => void;

type AuthenticatedUrl = (this: HostConnectionHandle, baseUrl: string) => string;

export async function apply(ctx: Context): Promise<void> {
  const config = readAuthConfig();
  if (config === undefined) {
    return;
  }
  if (config.allowInsecureRequests) {
    ctx
      .logger(name)
      .warn(
        "dsh-yawn auth: insecure HTTP requests are enabled; use this for development only",
      );
  }
  const secret = await loadSessionSecret(ctx.credentials);
  const session = new SessionCodec(
    secret,
    config.cookieMaxAgeDays * DAY_MS,
    config.secureCookies,
  );
  const auth = new BuiltInAuth(
    config,
    session,
    new OpenIdFlow(config),
    (message) => ctx.logger(name).warn(message),
  );

  registerRoute(ctx, AUTH_LOGIN_PATH, (req, res) => auth.login(req, res));
  registerRoute(ctx, AUTH_CALLBACK_PATH, (req, res) => auth.callback(req, res));
  registerRoute(ctx, AUTH_LOGOUT_PATH, (req, res) => auth.logout(req, res));
  registerRoute(ctx, AUTH_HEALTH_PATH, (req, res) => auth.health(req, res));

  // `ctx.connection` is a cordis proxy that rebinds `this` per caller; define
  // the wrappers on the instance behind it, as the other wrapping rows do.
  const connection =
    (Reflect.get(ctx.connection, symbols.original) as
      | HostConnectionHandle
      | undefined) ?? ctx.connection;
  ctx.effect(
    () => auth.wrap(connection),
    `${name}: replace dsh browser authentication`,
  );
}

function registerRoute(
  ctx: Context,
  path: string,
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): void {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path,
        handler,
      }),
    `${name}: ${path} route`,
  );
}

async function loadSessionSecret(
  credentials: CredentialProvider,
): Promise<Buffer> {
  const current = parseSecret(await credentials.readRecord(SESSION_SECRET_KEY));
  if (current !== undefined) {
    return current;
  }
  const generated: CredentialRecord = {
    kind: "grant",
    payload: {
      version: 1,
      secret: randomBytes(32).toString("base64url"),
    },
  };
  await credentials.modifyRecord(SESSION_SECRET_KEY, (record) =>
    Promise.resolve(parseSecret(record) === undefined ? generated : undefined),
  );
  const stored = parseSecret(await credentials.readRecord(SESSION_SECRET_KEY));
  if (stored === undefined) {
    throw new Error(
      "dsh-yawn auth: could not store the browser-session signing secret",
    );
  }
  return stored;
}

function parseSecret(record: CredentialRecord | undefined): Buffer | undefined {
  if (
    record === undefined ||
    record.kind !== "grant" ||
    typeof record.payload !== "object" ||
    record.payload === null ||
    !("version" in record.payload) ||
    record.payload.version !== 1 ||
    !("secret" in record.payload) ||
    typeof record.payload.secret !== "string"
  ) {
    return undefined;
  }
  const secret = Buffer.from(record.payload.secret, "base64url");
  if (secret.byteLength !== 32) {
    return undefined;
  }
  return secret;
}

function decodeSession(
  value: string,
  secret: Buffer,
): SessionPayload | undefined {
  const [version, body, signature, ...rest] = value.split(".");
  if (
    rest.length !== 0 ||
    version !== `v${SESSION_VERSION}` ||
    body === undefined ||
    signature === undefined
  ) {
    return undefined;
  }
  const provided = Buffer.from(signature, "base64url");
  const expected = createHmac("sha256", secret).update(body).digest();
  if (
    provided.byteLength !== expected.byteLength ||
    !timingSafeEqual(provided, expected)
  ) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    parsed.version !== SESSION_VERSION ||
    !("authority" in parsed) ||
    typeof parsed.authority !== "string" ||
    !("subject" in parsed) ||
    typeof parsed.subject !== "string" ||
    !("issuedAt" in parsed) ||
    typeof parsed.issuedAt !== "number" ||
    !Number.isSafeInteger(parsed.issuedAt) ||
    !("expiresAt" in parsed) ||
    typeof parsed.expiresAt !== "number" ||
    !Number.isSafeInteger(parsed.expiresAt)
  ) {
    return undefined;
  }
  const decoded = parsed as Record<string, unknown>;
  return {
    version: SESSION_VERSION,
    authority: parsed.authority,
    subject: parsed.subject,
    ...(typeof decoded.email === "string" ? { email: decoded.email } : {}),
    ...(typeof decoded.name === "string" ? { name: decoded.name } : {}),
    issuedAt: parsed.issuedAt,
    expiresAt: parsed.expiresAt,
  };
}

function admits(config: AuthConfig, identity: OidcIdentity): boolean {
  if (config.emailDomains.includes("*")) {
    return true;
  }
  const email = identity.email?.trim().toLowerCase();
  if (
    email === undefined ||
    !email.includes("@") ||
    identity.emailVerified === false
  ) {
    return false;
  }
  const domain = email.slice(email.lastIndexOf("@") + 1);
  return config.emailDomains.includes(domain);
}

function requestAuthority(request: ConnectionTrustRequest): string | undefined {
  const host = header(request.headers, "host");
  if (host === undefined) {
    return undefined;
  }
  try {
    return new URL(`http://${host}`).host.toLowerCase();
  } catch {
    return undefined;
  }
}

function header(
  headers: ConnectionTrustRequest["headers"],
  name: string,
): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

function cookieValue(raw: string, name: string): string | undefined {
  for (const segment of raw.split(";")) {
    const at = segment.indexOf("=");
    if (at === -1 || segment.slice(0, at).trim() !== name) {
      continue;
    }
    return segment.slice(at + 1).trim();
  }
  return undefined;
}

function value(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function booleanValue(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = value(env, name);
  if (raw === undefined) {
    return false;
  }
  if (raw === "1" || raw.toLowerCase() === "true") {
    return true;
  }
  if (raw === "0" || raw.toLowerCase() === "false") {
    return false;
  }
  throw new Error(`dsh-yawn auth: ${name} must be true or false`);
}

function optionalBooleanValue(
  env: NodeJS.ProcessEnv,
  name: string,
): boolean | undefined {
  return value(env, name) === undefined ? undefined : booleanValue(env, name);
}

function clientAuthMethodValue(
  env: NodeJS.ProcessEnv,
  clientSecret: string | undefined,
): ClientAuthMethod {
  const raw = value(env, AUTH_ENV.clientAuthMethod);
  if (raw === undefined) {
    return clientSecret === undefined ? "none" : "client_secret_post";
  }
  if (
    raw !== "client_secret_post" &&
    raw !== "client_secret_basic" &&
    raw !== "none"
  ) {
    throw new Error(
      `dsh-yawn auth: ${AUTH_ENV.clientAuthMethod} must be client_secret_post, client_secret_basic, or none`,
    );
  }
  if (raw !== "none" && clientSecret === undefined) {
    throw new Error(
      `dsh-yawn auth: ${AUTH_ENV.clientAuthMethod}=${raw} requires ${AUTH_ENV.clientSecret}`,
    );
  }
  return raw;
}

function integerValue(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = value(env, name);
  if (raw === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`dsh-yawn auth: ${name} must be an integer`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed < min || parsed > max) {
    throw new Error(`dsh-yawn auth: ${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

function urlValue(name: string, raw: string, allowInsecure: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`dsh-yawn auth: ${name} is not a URL`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`dsh-yawn auth: ${name} must not carry credentials`);
  }
  if (!allowInsecure && url.protocol !== "https:") {
    throw new Error(
      `dsh-yawn auth: ${name} must use https; set ${AUTH_ENV.allowInsecure}=1 only for development`,
    );
  }
  return url;
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeMethodNotAllowed(res: ServerResponse): void {
  res.writeHead(405, { allow: "GET, HEAD" });
  res.end();
}

function writeBadRequest(res: ServerResponse, message: string): void {
  res.writeHead(400, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(`${message}\n`);
}

function writeForbidden(res: ServerResponse): void {
  res.writeHead(403, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end("this account is not allowed to use this control plane\n");
}

function writeUnavailable(res: ServerResponse): void {
  res.writeHead(503, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end("sign-in is temporarily unavailable\n");
}
