/**
 * Shared HTTP and dsh-session plumbing for the sign-in rows.
 *
 * Passcode and OIDC are two ways to prove a user may enter. Both then need the
 * same things: send a logged-out index request to `/login`, refuse dsh's
 * launch-token URL, mint dsh's browser cookie through dsh's own exchange, and
 * clear that cookie on logout. Keeping that here means neither sign-in method
 * reimplements dsh's cookie format or gateway.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { Context } from "@deepseek-ai/cordis";
import type {
  ConnectionIndexResponse,
  HostConnectionHandle,
} from "@deepseek-ai/dsh-client-connection";

/** The sign-in form and its POST target. */
export const LOGIN_PATH = "/login";
/** Clears the dsh cookie and returns to the login form. */
export const LOGOUT_PATH = "/logout";

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

/** A single request header as text, whether node:http or Fetch shaped. */
export function header(request: IncomingMessage, name: string): string {
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

function securityHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    // Do not send `Referrer-Policy: no-referrer` here. Chrome submits a form
    // from such a page with `Origin: null`, and dsh's Host/Origin fence
    // rejects that before this row sees the credential. Redirects still carry
    // no-referrer, which is where the URL could leak a token.
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  };
}

export function sendHtml(
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

export function sendText(
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

export function redirect(
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
export function mintDshCookie(
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
 * Authenticated requests return undefined; untrusted authorities return 403.
 * A trusted but logged-out request returns 401 and may use the login form.
 */
export function untrusted(
  connection: HostConnectionHandle,
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  if (connection.requestRejection(request) === 403) {
    sendText(response, 403, "forbidden\n");
    return true;
  }
  return false;
}

export function loggedIn(
  connection: HostConnectionHandle,
  request: IncomingMessage,
): boolean {
  return connection.requestRejection(request) === undefined;
}

/**
 * Put a login page in front of dsh's browser authentication. A logged-out
 * index request goes to `loginPath`; dsh's token URL is refused while this
 * gate is mounted.
 */
export function installIndexGate(
  ctx: Context,
  loginPath: string,
  authorizeIndex: HostConnectionHandle["authorizeIndex"],
): void {
  const connection = ctx.connection;
  ctx.effect(() => {
    connection.authorizeIndex = function (request, response) {
      if (request.method === "GET" || request.method === "HEAD") {
        if (hasLaunchToken(request as IncomingMessage)) {
          redirect(response as ServerResponse, loginPath);
          return false;
        }
        const probe = capture();
        if (authorizeIndex(request, probe)) {
          return true;
        }
        if (probe.status === 401) {
          redirect(response as ServerResponse, loginPath);
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
  }, "auth: index gate");
}

/** A side-effect-free readiness route for Kubernetes and operators. */
export function installHealth(
  ctx: Context,
  healthy: () => boolean = () => true,
): void {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/healthz",
        handler: (_request, response) => {
          const ready = healthy();
          sendText(
            response,
            ready ? 200 : 503,
            ready ? "ok\n" : "sign-in configuration invalid\n",
          );
        },
      }),
    "auth: health route",
  );
}

/** Clear dsh's browser cookie and return to the login form. */
export function installLogout(
  ctx: Context,
  loginPath: string,
  authorizeIndex: HostConnectionHandle["authorizeIndex"],
): void {
  const connection = ctx.connection;
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: LOGOUT_PATH,
        handler: (request, response) => {
          if (untrusted(connection, request, response)) {
            return;
          }
          if (request.method !== "GET" && request.method !== "HEAD") {
            sendText(response, 405, "method not allowed\n", {
              allow: "GET, HEAD",
            });
            return;
          }
          if (!loggedIn(connection, request)) {
            redirect(response, loginPath);
            return;
          }
          // dsh has no logout; its cookie name is part of its private format.
          // Mint one through the same public exchange only to learn the name,
          // then expire it in the browser.
          const cookie = mintDshCookie(connection, authorizeIndex, request);
          const name = cookie === undefined ? undefined : cookieName(cookie);
          if (name === undefined) {
            redirect(response, loginPath);
            return;
          }
          redirect(response, loginPath, {
            "set-cookie": `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
          });
        },
      }),
    "auth: logout route",
  );
}
