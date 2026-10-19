/**
 * Replaces dsh's launch-token login with a passcode the operator sets at
 * deployment time.
 *
 * dsh authenticates a browser by exchanging a per-process launch token for a
 * signed cookie. That token is printed to the host log, so a deployment that
 * wants a stable front door either hands it out (`/launch-token`) or asks the
 * user to read it. Both are bypasses: they turn "knows the token" into "can
 * reach the port".
 *
 * This row keeps dsh's cookie as the only session credential but puts a
 * passcode in front of the exchange. A logged-out browser is sent to `/login`;
 * a correct passcode makes this row perform dsh's own token exchange
 * server-side, so the launch token never reaches the browser. Login responses
 * carry no token, and `?token=` on the index is refused while the row is
 * mounted.
 *
 * The passcode comes from `DSH_YAWN_PASSCODE`. It is compared by digest in
 * constant time and failed attempts are rate-limited per peer address. The
 * image entrypoint mounts the row only when that variable holds at least
 * eight characters, and validates it before dsh starts: dsh treats a row
 * that fails to activate as a warning and keeps serving, so the image cannot
 * rely on this module's constructor to stop a half-configured boot.
 *
 * @module @zhming0/dsh-yawn/passcode-auth
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Context } from "@deepseek-ai/cordis";
import type {
  ConnectionIndexResponse,
  HostConnectionHandle,
} from "@deepseek-ai/dsh-client-connection";

/** The deployment-provided passcode. */
export const PASSCODE_ENV = "DSH_YAWN_PASSCODE";
/** The login form and its POST target. */
export const LOGIN_PATH = "/login";
/** Clears the dsh cookie and returns to the login form. */
export const LOGOUT_PATH = "/logout";

const MIN_PASSCODE_LENGTH = 8;
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_PEERS = 1024;
const MAX_FORM_BYTES = 4096;

export const name = "sandbox-passcode-auth";
export const inject = ["webServer", "connection"];

export interface PasscodeAuthConfig {
  /** Overrides the environment variable. Tests use this. */
  passcode?: string;
}

interface CapturedResponse extends ConnectionIndexResponse {
  status: number;
  headers: Record<string, string>;
}

/** Collects what dsh's `authorizeIndex` would write, without touching the real response. */
function capture(): CapturedResponse {
  const captured: CapturedResponse = {
    status: 0,
    headers: {},
    writeHead(status, headers) {
      captured.status = status;
      Object.assign(captured.headers, headers ?? {});
      return captured;
    },
    end() {
      return captured;
    },
  };
  return captured;
}

/** SHA-256 makes the comparison independent of the passcode's length. */
function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function passcodeMatches(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

/** Whether the request is dsh's launch-token login URL. */
export function hasLaunchToken(request: IncomingMessage): boolean {
  try {
    return new URL(request.url ?? "/", "http://dsh.invalid").searchParams.has(
      "token",
    );
  } catch {
    return false;
  }
}

function header(request: IncomingMessage, name: string): string {
  const value: unknown = request.headers[name];
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    return typeof first === "string" ? first : "";
  }
  return "";
}

function isForm(request: IncomingMessage): boolean {
  return header(request, "content-type").startsWith(
    "application/x-www-form-urlencoded",
  );
}

/** Read a small form body; the login form is one field. */
async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array | string);
    size += buffer.length;
    if (size > MAX_FORM_BYTES) {
      throw new RangeError("form body too large");
    }
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/** One fixed-window budget per peer address. */
class Attempts {
  private readonly peers = new Map<
    string,
    { count: number; resetAt: number }
  >();

  /** Count one failure; returns the seconds to wait, or 0 when allowed. */
  fail(peer: string, now = Date.now()): number {
    this.prune(now);
    const previous = this.peers.get(peer);
    const entry =
      previous !== undefined && previous.resetAt > now
        ? { count: previous.count + 1, resetAt: previous.resetAt }
        : { count: 1, resetAt: now + ATTEMPT_WINDOW_MS };
    this.peers.set(peer, entry);
    return entry.count >= MAX_ATTEMPTS
      ? Math.ceil((entry.resetAt - now) / 1000)
      : 0;
  }

  clear(peer: string): void {
    this.peers.delete(peer);
  }

  private prune(now: number): void {
    if (this.peers.size < MAX_TRACKED_PEERS) {
      return;
    }
    for (const [peer, entry] of this.peers) {
      if (entry.resetAt <= now) {
        this.peers.delete(peer);
      }
    }
    // All budgets are live: drop the oldest peer so a spoofed source cannot
    // grow this map without bound.
    if (this.peers.size >= MAX_TRACKED_PEERS) {
      const oldest = this.peers.keys().next().value;
      if (oldest !== undefined) {
        this.peers.delete(oldest);
      }
    }
  }
}

function peerOf(request: IncomingMessage): string {
  return request.socket?.remoteAddress ?? "unknown";
}

function securityHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    // Do not send `Referrer-Policy: no-referrer` here. Chrome submits a form
    // from such a page with `Origin: null`, and dsh's Host/Origin fence
    // rejects that before this row sees the passcode. Redirects still carry
    // no-referrer, which is where the URL could leak a token.
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  };
}

function loginPage(error: string | undefined): string {
  const message = error === undefined ? "" : `<p role="alert">${error}</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; }
  main { width: min(22rem, calc(100vw - 3rem)); }
  h1 { font-size: 1.25rem; margin: 0 0 1.5rem; }
  label { display: block; margin-bottom: 1rem; }
  input { box-sizing: border-box; width: 100%; margin-top: .25rem; padding: .6rem; font: inherit; }
  button { padding: .6rem 1rem; font: inherit; }
  p[role="alert"] { color: #b3261e; margin: 0 0 1rem; }
</style>
</head>
<body>
<main>
<h1>DeepSeek Harness</h1>
${message}
<form method="post" action="${LOGIN_PATH}">
  <label>Passcode
    <input type="password" name="passcode" autocomplete="current-password" required autofocus>
  </label>
  <button type="submit">Sign in</button>
</form>
</main>
</body>
</html>
`;
}

function sendHtml(
  response: ServerResponse,
  status: number,
  body: string,
  extra: Record<string, string> = {},
): void {
  response.writeHead(status, {
    ...securityHeaders("text/html; charset=utf-8"),
    ...extra,
  });
  response.end(body);
}

function sendText(
  response: ServerResponse,
  status: number,
  body: string,
  extra: Record<string, string> = {},
): void {
  response.writeHead(status, {
    ...securityHeaders("text/plain; charset=utf-8"),
    ...extra,
  });
  response.end(body);
}

function redirect(
  response: ServerResponse,
  location: string,
  extra: Record<string, string> = {},
): void {
  response.writeHead(303, {
    location,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    ...extra,
  });
  response.end();
}

/**
 * Exchange dsh's launch token for a browser cookie without sending the token
 * to the client. `authorizeIndex` already owns the exchange; calling it with a
 * synthetic root request keeps the cookie format, audience, and TLS rule in
 * dsh's hands.
 */
function mintDshCookie(
  connection: HostConnectionHandle,
  authorizeIndex: HostConnectionHandle["authorizeIndex"],
  request: IncomingMessage,
): string | undefined {
  const token = new URL(
    connection.authenticatedUrl("http://dsh.invalid"),
  ).searchParams.get("token");
  if (token === null) {
    return undefined;
  }
  const captured = capture();
  authorizeIndex(
    {
      method: "GET",
      url: `/?token=${encodeURIComponent(token)}`,
      headers: request.headers,
    },
    captured,
  );
  const cookie = captured.headers["set-cookie"];
  return typeof cookie === "string" ? cookie : undefined;
}

function cookieName(cookie: string): string | undefined {
  const separator = cookie.indexOf("=");
  return separator <= 0 ? undefined : cookie.slice(0, separator);
}

/**
 * Put the passcode in front of dsh's browser login and keep dsh's cookie as
 * the session it mints.
 */
export function apply(ctx: Context, config?: PasscodeAuthConfig): void {
  const passcode = config?.passcode ?? process.env[PASSCODE_ENV] ?? "";
  if (passcode.length < MIN_PASSCODE_LENGTH) {
    throw new Error(
      `${PASSCODE_ENV} must be set to at least ${String(MIN_PASSCODE_LENGTH)} characters`,
    );
  }

  const connection = ctx.connection;
  const authorizeIndex = connection.authorizeIndex.bind(connection);
  const attempts = new Attempts();

  /**
   * Authenticated requests return undefined; untrusted authorities return 403.
   * A trusted but logged-out request returns 401 and may use the login form.
   */
  function untrusted(
    request: IncomingMessage,
    response: ServerResponse,
  ): boolean {
    if (connection.requestRejection(request) === 403) {
      sendText(response, 403, "forbidden\n");
      return true;
    }
    return false;
  }

  function loggedIn(request: IncomingMessage): boolean {
    return connection.requestRejection(request) === undefined;
  }

  function handleLogin(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> | void {
    if (untrusted(request, response)) {
      return;
    }
    if (loggedIn(request)) {
      redirect(response, "/");
      return;
    }
    if (request.method === "GET" || request.method === "HEAD") {
      const body = loginPage(undefined);
      sendHtml(response, 200, request.method === "HEAD" ? "" : body);
      return;
    }
    if (request.method !== "POST") {
      sendText(response, 405, "method not allowed\n", {
        allow: "GET, HEAD, POST",
      });
      return;
    }
    if (!isForm(request)) {
      sendText(response, 415, "expected a form submission\n");
      return;
    }
    return readForm(request)
      .then((form) => {
        const given = form.get("passcode") ?? "";
        if (!passcodeMatches(given, passcode)) {
          const wait = attempts.fail(peerOf(request));
          if (wait > 0) {
            sendText(response, 429, "too many attempts\n", {
              "retry-after": String(wait),
            });
            return;
          }
          sendHtml(response, 401, loginPage("Wrong passcode."));
          return;
        }
        attempts.clear(peerOf(request));
        const cookie = mintDshCookie(connection, authorizeIndex, request);
        if (cookie === undefined) {
          sendText(response, 500, "sign-in failed\n");
          return;
        }
        redirect(response, "/", { "set-cookie": cookie });
      })
      .catch((error: unknown) => {
        if (error instanceof RangeError) {
          sendText(response, 413, "form body too large\n");
          return;
        }
        ctx.logger.warn(
          `${name}: sign-in failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        sendText(response, 500, "sign-in failed\n");
      });
  }

  function handleLogout(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    if (untrusted(request, response)) {
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendText(response, 405, "method not allowed\n", { allow: "GET, HEAD" });
      return;
    }
    if (!loggedIn(request)) {
      redirect(response, LOGIN_PATH);
      return;
    }
    // dsh has no logout; its cookie name is part of its private format. Mint
    // one through the same public exchange only to learn the name, then expire
    // it in the browser.
    const cookie = mintDshCookie(connection, authorizeIndex, request);
    const name = cookie === undefined ? undefined : cookieName(cookie);
    if (name === undefined) {
      redirect(response, LOGIN_PATH);
      return;
    }
    redirect(response, LOGIN_PATH, {
      "set-cookie": `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    });
  }

  ctx.effect(() => {
    connection.authorizeIndex = function (request, response) {
      if (request.method === "GET" || request.method === "HEAD") {
        if (hasLaunchToken(request as IncomingMessage)) {
          redirect(response as ServerResponse, LOGIN_PATH);
          return false;
        }
        const probe = capture();
        if (authorizeIndex(request, probe)) {
          return true;
        }
        if (probe.status === 401) {
          redirect(response as ServerResponse, LOGIN_PATH);
          return false;
        }
        const status = probe.status === 0 ? 500 : probe.status;
        (response as ServerResponse).writeHead(status, probe.headers);
        (response as ServerResponse).end();
        return false;
      }
      const probe = capture();
      if (authorizeIndex(request, probe)) {
        return true;
      }
      const status = probe.status === 0 ? 401 : probe.status;
      (response as ServerResponse).writeHead(status, probe.headers);
      (response as ServerResponse).end();
      return false;
    };
    return () => {
      connection.authorizeIndex = authorizeIndex;
    };
  }, `${name}: index gate`);

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: LOGIN_PATH,
        handler: (request, response) => handleLogin(request, response),
      }),
    `${name}: ${LOGIN_PATH} route`,
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: LOGOUT_PATH,
        handler: (request, response) => handleLogout(request, response),
      }),
    `${name}: ${LOGOUT_PATH} route`,
  );
}
