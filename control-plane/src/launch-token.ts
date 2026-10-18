import type { IncomingMessage, ServerResponse } from "node:http";

import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-connection";
import type {} from "@deepseek-ai/dsh-host-webserver";

/**
 * Hands out dsh's launch token for deployments where something else already
 * authenticates users, such as a reverse proxy in front of a port-forward
 * install. dsh's own browser login is the `?token=` URL it prints at startup;
 * `GET /launch-token` answers with a redirect to that URL so nobody has to read
 * the token from the host log. The control plane's built-in OIDC sign-in does
 * not use this row.
 *
 * This is not a sign-in: it bypasses dsh's one check. Anyone who can reach
 * dsh's port can use it, so the row is only mounted where reaching the port
 * already means having passed authentication.
 */
export const LAUNCH_TOKEN_PATH = "/launch-token";

export const name = "sandbox-launch-token";
export const inject = ["webServer", "connection"];

export function apply(ctx: Context): void {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: LAUNCH_TOKEN_PATH,
        handler: (req, res) => {
          redirectToAuthenticatedRoot(ctx, req, res);
        },
      }),
    `${name}: ${LAUNCH_TOKEN_PATH} route`,
  );
}

function redirectToAuthenticatedRoot(
  ctx: Context,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return;
  }
  // A relative Location keeps whatever authority the browser used, which is
  // the one dsh binds the session cookie to. Only the query is taken from
  // dsh; the base URL is a placeholder.
  const { search } = new URL(
    ctx.connection.authenticatedUrl("http://dsh.invalid"),
  );
  res.writeHead(303, {
    location: `/${search}`,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  res.end();
}
