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
import type { HostConnectionHandle } from "@deepseek-ai/dsh-client-connection";

import {
  LOGIN_PATH,
  LOGOUT_PATH,
  hasLaunchToken,
  header,
  installHealth,
  installIndexGate,
  installLogout,
  loggedIn,
  mintDshCookie,
  redirect,
  sendHtml,
  sendText,
  untrusted,
} from "./auth-core.js";

export { LOGIN_PATH, LOGOUT_PATH, hasLaunchToken };

/** The deployment-provided passcode. */
export const PASSCODE_ENV = "DSH_YAWN_PASSCODE";

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

/** SHA-256 makes the comparison independent of the passcode's length. */
function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function passcodeMatches(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

function isForm(request: IncomingMessage): boolean {
  return header(request, "content-type").startsWith(
    "application/x-www-form-urlencoded",
  );
}

/** Read the one-field login form; bounded so a large body cannot grow memory. */
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

function handleLogin(
  ctx: Context,
  connection: HostConnectionHandle,
  authorizeIndex: HostConnectionHandle["authorizeIndex"],
  passcode: string,
  attempts: Attempts,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> | void {
  if (untrusted(connection, request, response)) {
    return;
  }
  if (loggedIn(connection, request)) {
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

  installIndexGate(ctx, LOGIN_PATH, authorizeIndex);
  installHealth(ctx);

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: LOGIN_PATH,
        handler: (request, response) =>
          handleLogin(
            ctx,
            connection,
            authorizeIndex,
            passcode,
            attempts,
            request,
            response,
          ),
      }),
    `${name}: ${LOGIN_PATH} route`,
  );

  installLogout(ctx, LOGIN_PATH, authorizeIndex);
}
