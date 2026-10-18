import type { IncomingMessage, ServerResponse } from "node:http";

import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";

import * as oidcAuth from "../src/oidc-auth.js";
import type { OidcLibrary } from "../src/oidc-auth.js";

const COOKIE = "dsh-auth-test=v1.payload.signature";
const REDIRECT = "https://dsh.example/oidc/callback";

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
  } = {},
): IncomingMessage {
  const headers: Record<string, string> = {
    host: options.host ?? "dsh.example",
  };
  if (options.cookie !== undefined) {
    headers.cookie = options.cookie;
  }
  return {
    method: options.method ?? "GET",
    url: options.url ?? "/",
    headers,
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}

function library(
  email = "alice@example.com",
  emailVerified: unknown = true,
): OidcLibrary {
  return {
    randomPKCECodeVerifier: () => "verifier",
    calculatePKCECodeChallenge: async () => "challenge",
    randomState: () => "state",
    randomNonce: () => "nonce",
    allowInsecureRequests: () => "insecure",
    discovery: async () => ({}),
    buildAuthorizationUrl: (
      _configuration: unknown,
      parameters: Record<string, string>,
    ) => {
      const url = new URL("https://idp.example/authorize");
      for (const [key, value] of Object.entries(parameters)) {
        url.searchParams.set(key, value);
      }
      return url;
    },
    authorizationCodeGrant: async () =>
      ({
        claims: () => ({ email, email_verified: emailVerified }),
      }) as never,
  } as unknown as OidcLibrary;
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
      response: {
        writeHead: (
          status: number,
          headers?: Record<string, string>,
        ) => unknown;
        end: () => unknown;
      },
    ) => boolean;
    authenticatedUrl: (base: string) => string;
    requestRejection: (request: IncomingMessage) => 401 | 403 | undefined;
  };
}

async function mount(
  options: {
    library?: OidcLibrary;
    allowedEmails?: string[];
    allowedDomains?: string[];
    redirectUrl?: string;
    allowUnverifiedEmail?: boolean;
  } = {},
): Promise<Mounted> {
  const ctx = new Context();
  const routes = new Map<
    string,
    (request: IncomingMessage, response: ServerResponse) => unknown
  >();
  const connection = {
    authorizeIndex(
      candidate: IncomingMessage,
      out: {
        writeHead: (
          status: number,
          headers?: Record<string, string>,
        ) => unknown;
        end: () => unknown;
      },
    ): boolean {
      if (/[?&]token=/.test(candidate.url ?? "")) {
        out.writeHead(303, { "set-cookie": COOKIE });
        out.end();
        return false;
      }
      return candidate.headers.cookie === COOKIE;
    },
    authenticatedUrl(base: string): string {
      const url = new URL(base);
      url.searchParams.set("token", "process-token");
      return url.href;
    },
    requestRejection(candidate: IncomingMessage): 401 | 403 | undefined {
      if (candidate.headers.host === "evil.example") {
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
  await ctx.plugin(oidcAuth, {
    issuer: "https://idp.example",
    clientId: "client",
    redirectUrl: options.redirectUrl ?? REDIRECT,
    allowedEmails: options.allowedEmails ?? ["alice@example.com"],
    allowedDomains: options.allowedDomains,
    allowUnverifiedEmail: options.allowUnverifiedEmail,
    library: options.library ?? library(),
  });
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

describe("OIDC auth", () => {
  it("starts the authorization code flow with state, nonce, and PKCE", async () => {
    const mounted = await mount();
    try {
      const out = await dispatch(
        mounted.routes,
        "/login",
        request({ url: "/login" }),
      );
      expect(out.status).toBe(303);
      const target = new URL(out.headers.location ?? "");
      expect(target.origin).toBe("https://idp.example");
      expect(target.searchParams.get("state")).toBe("state");
      expect(target.searchParams.get("nonce")).toBe("nonce");
      expect(target.searchParams.get("code_challenge")).toBe("challenge");
      expect(target.searchParams.get("code_challenge_method")).toBe("S256");
      expect(out.headers["set-cookie"]).toBeUndefined();
    } finally {
      await mounted.ctx.fiber.dispose();
    }
  });

  it("mints dsh's cookie after an allowed callback", async () => {
    const mounted = await mount();
    try {
      await dispatch(mounted.routes, "/login", request({ url: "/login" }));
      const out = await dispatch(
        mounted.routes,
        "/oidc/callback",
        request({ url: `${new URL(REDIRECT).pathname}?state=state&code=code` }),
      );
      expect(out.status).toBe(303);
      expect(out.headers.location).toBe("/");
      expect(out.headers["set-cookie"]).toBe(COOKIE);
      expect(out.body).not.toContain("process-token");
    } finally {
      await mounted.ctx.fiber.dispose();
    }
  });

  it("refuses an email outside the allowlist", async () => {
    const mounted = await mount({ library: library("bob@example.com") });
    try {
      await dispatch(mounted.routes, "/login", request({ url: "/login" }));
      const out = await dispatch(
        mounted.routes,
        "/oidc/callback",
        request({ url: `${new URL(REDIRECT).pathname}?state=state&code=code` }),
      );
      expect(out.status).toBe(401);
      expect(out.headers["set-cookie"]).toBeUndefined();
    } finally {
      await mounted.ctx.fiber.dispose();
    }
  });

  it("accepts an unverified email by default", async () => {
    const mounted = await mount({
      library: library("alice@example.com", false),
    });
    try {
      await dispatch(mounted.routes, "/login", request({ url: "/login" }));
      const out = await dispatch(
        mounted.routes,
        "/oidc/callback",
        request({ url: `${new URL(REDIRECT).pathname}?state=state&code=code` }),
      );
      expect(out.status).toBe(303);
      expect(out.headers.location).toBe("/");
      expect(out.headers["set-cookie"]).toBe(COOKIE);
    } finally {
      await mounted.ctx.fiber.dispose();
    }
  });

  it("refuses an unverified email when verification is required", async () => {
    const mounted = await mount({
      library: library("alice@example.com", false),
      allowUnverifiedEmail: false,
    });
    try {
      await dispatch(mounted.routes, "/login", request({ url: "/login" }));
      const out = await dispatch(
        mounted.routes,
        "/oidc/callback",
        request({ url: `${new URL(REDIRECT).pathname}?state=state&code=code` }),
      );
      expect(out.status).toBe(401);
      expect(out.headers["set-cookie"]).toBeUndefined();
    } finally {
      await mounted.ctx.fiber.dispose();
    }
  });

  it("answers /healthz without contacting the issuer", async () => {
    let discoveries = 0;
    const fake = library();
    fake.discovery = async () => {
      discoveries += 1;
      return {} as never;
    };
    const mounted = await mount({ library: fake });
    try {
      const out = await dispatch(
        mounted.routes,
        "/healthz",
        request({ url: "/healthz" }),
      );
      expect(out.status).toBe(200);
      expect(out.body).toBe("ok\n");
      expect(discoveries).toBe(0);
    } finally {
      await mounted.ctx.fiber.dispose();
    }
  });

  it("refuses a callback with an unknown state", async () => {
    const mounted = await mount();
    try {
      const out = await dispatch(
        mounted.routes,
        "/oidc/callback",
        request({
          url: `${new URL(REDIRECT).pathname}?state=unknown&code=code`,
        }),
      );
      expect(out.status).toBe(401);
      expect(out.headers["set-cookie"]).toBeUndefined();
    } finally {
      await mounted.ctx.fiber.dispose();
    }
  });

  it("refuses dsh's launch-token index URL", async () => {
    const mounted = await mount();
    try {
      const out = reply();
      expect(
        mounted.connection.authorizeIndex(
          request({ url: "/?token=process-token" }),
          response(out),
        ),
      ).toBe(false);
      expect(out.status).toBe(303);
      expect(out.headers.location).toBe("/login");
    } finally {
      await mounted.ctx.fiber.dispose();
    }
  });

  it("keeps the gate closed when configuration is invalid", async () => {
    for (const options of [
      { allowedEmails: [], allowedDomains: [] },
      { redirectUrl: "http://example.com/callback" },
    ]) {
      const mounted = await mount(options);
      try {
        const login = await dispatch(
          mounted.routes,
          "/login",
          request({ url: "/login" }),
        );
        expect(login.status).toBe(503);
        const health = await dispatch(
          mounted.routes,
          "/healthz",
          request({ url: "/healthz" }),
        );
        expect(health.status).toBe(503);

        const index = reply();
        expect(
          mounted.connection.authorizeIndex(
            request({ url: "/?token=process-token" }),
            response(index),
          ),
        ).toBe(false);
        expect(index.headers.location).toBe("/login");
      } finally {
        await mounted.ctx.fiber.dispose();
      }
    }
  });

  it("routes the configured callback path", async () => {
    const redirectUrl = "https://dsh.example/oidc/custom";
    const mounted = await mount({ redirectUrl });
    try {
      await dispatch(mounted.routes, "/login", request({ url: "/login" }));
      const out = await dispatch(
        mounted.routes,
        new URL(redirectUrl).pathname,
        request({ url: "/oidc/custom?state=state&code=code" }),
      );
      expect(out.status).toBe(303);
      expect(out.headers.location).toBe("/");
      expect(out.headers["set-cookie"]).toBe(COOKIE);
    } finally {
      await mounted.ctx.fiber.dispose();
    }
  });

  it("matches exact emails and domains", () => {
    expect(
      oidcAuth.emailAllowed(
        { email: "Alice@Example.com" },
        ["alice@example.com"],
        [],
      ),
    ).toBe(true);
    expect(
      oidcAuth.emailAllowed(
        { email: "alice@example.com" },
        [],
        ["example.com"],
      ),
    ).toBe(true);
    expect(
      oidcAuth.emailAllowed(
        { email: "alice@sub.example.com" },
        [],
        ["example.com"],
      ),
    ).toBe(false);
    expect(
      oidcAuth.emailAllowed({ email: "notexample.com" }, [], ["example.com"]),
    ).toBe(false);
    expect(
      oidcAuth.emailAllowed(
        { email: "alice@example.com", email_verified: false },
        ["alice@example.com"],
        [],
      ),
    ).toBe(true);
    expect(
      oidcAuth.emailAllowed(
        { email: "alice@example.com", email_verified: false },
        ["alice@example.com"],
        [],
        false,
      ),
    ).toBe(false);
    expect(
      oidcAuth.emailAllowed(
        { email: "alice@example.com" },
        ["alice@example.com"],
        [],
        false,
      ),
    ).toBe(false);
    expect(oidcAuth.emailAllowed(undefined, ["alice@example.com"], [])).toBe(
      false,
    );
  });
});
