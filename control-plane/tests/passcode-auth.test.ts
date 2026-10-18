import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { Context } from "@deepseek-ai/cordis";
import type { ConnectionIndexResponse } from "@deepseek-ai/dsh-client-connection";
import { afterEach, describe, expect, it } from "vitest";

import * as passcodeAuth from "../src/passcode-auth.js";
import { LOGIN_PATH, LOGOUT_PATH, PASSCODE_ENV } from "../src/passcode-auth.js";

const PASSCODE = "correct horse battery";
const COOKIE = "dsh-auth-test=v1.payload.signature";

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function reply(): Reply {
  return { status: 0, headers: {}, body: "" };
}

function response(out: Reply): ServerResponse {
  return {
    writeHead(status: number, headers?: Record<string, string>) {
      out.status = status;
      Object.assign(out.headers, headers ?? {});
      return this;
    },
    end(body?: string) {
      out.body = body ?? "";
      return this;
    },
  } as unknown as ServerResponse;
}

function request(
  options: {
    method?: string;
    url?: string;
    host?: string;
    cookie?: string;
    body?: string;
    contentType?: string;
    remoteAddress?: string;
  } = {},
): IncomingMessage {
  const headers: Record<string, string> = {
    host: options.host ?? "localhost:3000",
  };
  if (options.cookie !== undefined) {
    headers.cookie = options.cookie;
  }
  if (options.body !== undefined) {
    headers["content-type"] =
      options.contentType ?? "application/x-www-form-urlencoded";
    headers["content-length"] = String(Buffer.byteLength(options.body));
  }
  const stream = Readable.from(
    options.body === undefined ? [] : [Buffer.from(options.body)],
  );
  return Object.assign(stream, {
    method: options.method ?? "GET",
    url: options.url ?? "/",
    headers,
    socket: { remoteAddress: options.remoteAddress ?? "127.0.0.1" },
  }) as unknown as IncomingMessage;
}

interface Mounted {
  ctx: Context;
  routes: Map<
    string,
    (request: IncomingMessage, response: ServerResponse) => unknown
  >;
  connection: {
    authorizeIndex: (
      request: IncomingMessage,
      response: ConnectionIndexResponse,
    ) => boolean;
    authenticatedUrl: (base: string) => string;
    requestRejection: (request: IncomingMessage) => 401 | 403 | undefined;
  };
}

async function mount(passcode = PASSCODE): Promise<Mounted> {
  const ctx = new Context();
  const routes = new Map<
    string,
    (request: IncomingMessage, response: ServerResponse) => unknown
  >();
  const connection = {
    authorizeIndex(
      candidate: IncomingMessage,
      out: ConnectionIndexResponse,
    ): boolean {
      if (/[?&]token=/.test(candidate.url ?? "")) {
        out.writeHead(303, { "set-cookie": COOKIE });
        out.end();
        return false;
      }
      if (candidate.headers.cookie === COOKIE) {
        return true;
      }
      out.writeHead(401, { "content-type": "text/plain" });
      out.end();
      return false;
    },
    authenticatedUrl(base: string): string {
      const url = new URL(base);
      url.searchParams.set("token", "process-token");
      return url.href;
    },
    requestRejection(candidate: IncomingMessage): 401 | 403 | undefined {
      if (candidate.headers.host === "evil.example.com") {
        return 403;
      }
      return candidate.headers.cookie === COOKIE ? undefined : 401;
    },
  };
  ctx.provide("webServer", {
    protocol: "http:",
    host: "127.0.0.1",
    register(route: {
      path: string;
      handler: (request: IncomingMessage, response: ServerResponse) => unknown;
    }) {
      routes.set(route.path, route.handler);
      return () => {
        routes.delete(route.path);
      };
    },
  });
  ctx.provide("connection", connection);
  await ctx.plugin(passcodeAuth, { passcode });
  return { ctx, routes, connection };
}

async function dispatch(
  routes: Map<
    string,
    (request: IncomingMessage, response: ServerResponse) => unknown
  >,
  path: string,
  incoming: IncomingMessage,
): Promise<Reply> {
  const out = reply();
  const handler = routes.get(path);
  expect(handler).toBeDefined();
  await handler?.(incoming, response(out));
  return out;
}

let mounted: Mounted | undefined;

afterEach(async () => {
  await mounted?.ctx.fiber.dispose();
  mounted = undefined;
});

describe("passcode auth", () => {
  it("sends an unauthenticated index request to the login page", async () => {
    mounted = await mount();
    const out = reply();
    expect(mounted.connection.authorizeIndex(request(), response(out))).toBe(
      false,
    );
    expect(out.status).toBe(303);
    expect(out.headers.location).toBe(LOGIN_PATH);
  });

  it("answers /healthz without authentication", async () => {
    mounted = await mount();
    const out = await dispatch(
      mounted.routes,
      "/healthz",
      request({ url: "/healthz" }),
    );
    expect(out.status).toBe(200);
    expect(out.body).toBe("ok\n");
  });

  it("refuses a launch-token index URL", async () => {
    mounted = await mount();
    const out = reply();
    expect(
      mounted.connection.authorizeIndex(
        request({ url: "/?token=process-token" }),
        response(out),
      ),
    ).toBe(false);
    expect(out.status).toBe(303);
    expect(out.headers.location).toBe(LOGIN_PATH);
    expect(out.headers["set-cookie"]).toBeUndefined();
  });

  it("serves the login page and rejects an untrusted authority", async () => {
    mounted = await mount();
    const page = await dispatch(
      mounted.routes,
      LOGIN_PATH,
      request({ url: LOGIN_PATH }),
    );
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.headers["referrer-policy"]).toBeUndefined();
    expect(page.body).toContain('name="passcode"');

    const forbidden = await dispatch(
      mounted.routes,
      LOGIN_PATH,
      request({ host: "evil.example.com" }),
    );
    expect(forbidden.status).toBe(403);
  });

  it("rejects a wrong passcode and rate-limits repeated attempts", async () => {
    mounted = await mount();
    for (let attempt = 1; attempt <= 9; attempt += 1) {
      const out = await dispatch(
        mounted.routes,
        LOGIN_PATH,
        request({
          method: "POST",
          url: LOGIN_PATH,
          body: "passcode=wrong",
        }),
      );
      expect(out.status).toBe(401);
    }
    const blocked = await dispatch(
      mounted.routes,
      LOGIN_PATH,
      request({
        method: "POST",
        url: LOGIN_PATH,
        body: "passcode=wrong",
      }),
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
  });

  it("mints dsh's cookie after a correct passcode and lets the index through", async () => {
    mounted = await mount();
    const login = await dispatch(
      mounted.routes,
      LOGIN_PATH,
      request({
        method: "POST",
        url: LOGIN_PATH,
        body: `passcode=${encodeURIComponent(PASSCODE)}`,
      }),
    );
    expect(login.status).toBe(303);
    expect(login.headers.location).toBe("/");
    expect(login.headers["set-cookie"]).toBe(COOKIE);
    expect(login.body).not.toContain("process-token");

    const index = reply();
    expect(
      mounted.connection.authorizeIndex(
        request({ cookie: COOKIE }),
        response(index),
      ),
    ).toBe(true);
  });

  it("clears dsh's cookie on logout", async () => {
    mounted = await mount();
    const out = await dispatch(
      mounted.routes,
      LOGOUT_PATH,
      request({ cookie: COOKIE }),
    );
    expect(out.status).toBe(303);
    expect(out.headers.location).toBe(LOGIN_PATH);
    expect(out.headers["set-cookie"]).toContain("dsh-auth-test=");
    expect(out.headers["set-cookie"]).toContain("Max-Age=0");
  });

  it("restores dsh's index authentication when disposed", async () => {
    mounted = await mount();
    const { ctx, connection, routes } = mounted;
    await ctx.fiber.dispose();
    mounted = undefined;
    expect(routes.size).toBe(0);

    const out = reply();
    expect(connection.authorizeIndex(request(), response(out))).toBe(false);
    expect(out.status).toBe(401);
  });

  it("fails closed when the passcode is missing or too short", async () => {
    await expect(mount("")).rejects.toThrow(PASSCODE_ENV);
    await expect(mount("short")).rejects.toThrow(PASSCODE_ENV);
  });
});
