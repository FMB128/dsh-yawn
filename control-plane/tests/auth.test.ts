import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  ConnectionTrustRequest,
  HostConnectionHandle,
  PeerAdmission,
} from "@deepseek-ai/dsh-client-connection";
import { describe, expect, it } from "vitest";

import * as auth from "../src/auth.js";

const SECRET = Buffer.alloc(32, 7);
const MAX_AGE_MS = 30 * 86_400_000;
const HOST = "dsh.example.com";

interface Reply {
  status: number;
  headers: Record<string, string>;
}

function config(overrides: Partial<auth.AuthConfig> = {}): auth.AuthConfig {
  return {
    issuer: new URL("https://idp.example/"),
    clientId: "dsh-yawn",
    redirectUrl: new URL(`https://${HOST}/dsh-yawn/auth/callback`),
    emailDomains: ["example.com"],
    scopes: "openid email profile",
    cookieMaxAgeDays: 30,
    secureCookies: true,
    clientAuthMethod: "client_secret_post",
    allowInsecureRequests: false,
    ...overrides,
  };
}

function incoming(
  url: string,
  headers: Record<string, string> = {},
  method = "GET",
): IncomingMessage {
  return { url, method, headers } as unknown as IncomingMessage;
}

function replyResponse(): { res: ServerResponse; reply: Reply } {
  const reply: Reply = { status: 0, headers: {} };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      reply.status = status;
      reply.headers = headers ?? {};
      return res;
    },
    end() {
      return res;
    },
  } as unknown as ServerResponse;
  return { res, reply };
}

function cookiePair(header: string): string {
  return header.split(";")[0] ?? "";
}

class FakeFlow implements auth.OidcFlow {
  readonly calls: Array<Record<string, string>> = [];
  identity: auth.OidcIdentity = {
    subject: "subject-1",
    email: "ada@example.com",
    name: "Ada",
  };

  async authorizationUrl(input: {
    state: string;
    nonce: string;
    codeChallenge: string;
  }): Promise<string> {
    this.calls.push({ kind: "authorization", ...input });
    return `https://idp.example/authorize?state=${encodeURIComponent(input.state)}`;
  }

  async exchange(input: {
    currentUrl: URL;
    state: string;
    nonce: string;
    codeVerifier: string;
  }): Promise<auth.OidcIdentity> {
    this.calls.push({
      kind: "exchange",
      state: input.state,
      nonce: input.nonce,
      codeVerifier: input.codeVerifier,
    });
    return this.identity;
  }
}

function makeAuth(
  options: {
    config?: Partial<auth.AuthConfig>;
    flow?: FakeFlow;
    session?: auth.SessionCodec;
    now?: () => number;
  } = {},
): {
  built: auth.BuiltInAuth;
  flow: FakeFlow;
  session: auth.SessionCodec;
  warnings: string[];
} {
  const flow = options.flow ?? new FakeFlow();
  const session =
    options.session ?? new auth.SessionCodec(SECRET, MAX_AGE_MS, true);
  const warnings: string[] = [];
  const built = new auth.BuiltInAuth(
    config(options.config),
    session,
    flow,
    (message) => warnings.push(message),
    options.now,
  );
  return { built, flow, session, warnings };
}

async function login(
  built: auth.BuiltInAuth,
): Promise<{ reply: Reply; state: string; cookie: string }> {
  const { res, reply } = replyResponse();
  await built.login(incoming("/"), res);
  const location = reply.headers["location"];
  expect(location).toBeDefined();
  const state = new URL(location!).searchParams.get("state");
  const setCookie = reply.headers["set-cookie"];
  expect(setCookie).toBeDefined();
  return { reply, state: state ?? "", cookie: cookiePair(setCookie!) };
}

async function callback(
  built: auth.BuiltInAuth,
  state: string,
  cookie: string,
  host = HOST,
): Promise<Reply> {
  const { res, reply } = replyResponse();
  await built.callback(
    incoming(
      `/dsh-yawn/auth/callback?state=${encodeURIComponent(state)}&code=code-1`,
      { host, cookie },
    ),
    res,
  );
  return reply;
}

describe("auth configuration", () => {
  it("is off when no OIDC names are set", () => {
    expect(auth.readAuthConfig({})).toBeUndefined();
  });

  it("parses a complete configuration and applies defaults", () => {
    const parsed = auth.readAuthConfig({
      DSH_YAWN_OIDC_ISSUER: "https://idp.example/",
      DSH_YAWN_OIDC_CLIENT_ID: "dsh-yawn",
      DSH_YAWN_OIDC_CLIENT_SECRET: "secret",
      DSH_YAWN_OIDC_REDIRECT_URL: `https://${HOST}/dsh-yawn/auth/callback`,
    });

    expect(parsed).toMatchObject({
      issuer: new URL("https://idp.example/"),
      clientId: "dsh-yawn",
      clientSecret: "secret",
      emailDomains: ["*"],
      scopes: "openid email profile",
      cookieMaxAgeDays: 30,
      secureCookies: true,
      clientAuthMethod: "client_secret_post",
      allowInsecureRequests: false,
    });
  });

  it("uses the public-client method when no secret is configured", () => {
    const parsed = auth.readAuthConfig({
      DSH_YAWN_OIDC_ISSUER: "https://idp.example/",
      DSH_YAWN_OIDC_CLIENT_ID: "dsh-yawn",
      DSH_YAWN_OIDC_REDIRECT_URL: `https://${HOST}/dsh-yawn/auth/callback`,
    });
    expect(parsed?.clientAuthMethod).toBe("none");
  });

  it("rejects a partial configuration", () => {
    expect(() =>
      auth.readAuthConfig({
        DSH_YAWN_OIDC_ISSUER: "https://idp.example/",
        DSH_YAWN_OIDC_CLIENT_ID: "dsh-yawn",
      }),
    ).toThrow(/must be set together/);
  });

  it("rejects an http issuer unless the development escape hatch is on", () => {
    const env = {
      DSH_YAWN_OIDC_ISSUER: "http://127.0.0.1:9999",
      DSH_YAWN_OIDC_CLIENT_ID: "dsh-yawn",
      DSH_YAWN_OIDC_REDIRECT_URL:
        "http://127.0.0.1:3000/dsh-yawn/auth/callback",
    };
    expect(() => auth.readAuthConfig(env)).toThrow(/must use https/);
    expect(
      auth.readAuthConfig({
        ...env,
        DSH_YAWN_OIDC_ALLOW_INSECURE: "1",
      }),
    ).toMatchObject({ allowInsecureRequests: true, secureCookies: false });
  });

  it("requires the registered redirect path", () => {
    expect(() =>
      auth.readAuthConfig({
        DSH_YAWN_OIDC_ISSUER: "https://idp.example/",
        DSH_YAWN_OIDC_CLIENT_ID: "dsh-yawn",
        DSH_YAWN_OIDC_REDIRECT_URL: `https://${HOST}/wrong`,
      }),
    ).toThrow(/must end at/);
  });

  it("parses email domains and validates the cookie lifetime", () => {
    const parsed = auth.readAuthConfig({
      DSH_YAWN_OIDC_ISSUER: "https://idp.example/",
      DSH_YAWN_OIDC_CLIENT_ID: "dsh-yawn",
      DSH_YAWN_OIDC_REDIRECT_URL: `https://${HOST}/dsh-yawn/auth/callback`,
      DSH_YAWN_OIDC_EMAIL_DOMAINS: "Example.com, ops.example.com",
      DSH_YAWN_OIDC_COOKIE_MAX_AGE_DAYS: "7",
    });
    expect(parsed?.emailDomains).toEqual(["example.com", "ops.example.com"]);
    expect(parsed?.cookieMaxAgeDays).toBe(7);

    expect(() =>
      auth.readAuthConfig({
        DSH_YAWN_OIDC_ISSUER: "https://idp.example/",
        DSH_YAWN_OIDC_CLIENT_ID: "dsh-yawn",
        DSH_YAWN_OIDC_REDIRECT_URL: `https://${HOST}/dsh-yawn/auth/callback`,
        DSH_YAWN_OIDC_COOKIE_MAX_AGE_DAYS: "0",
      }),
    ).toThrow(/between 1 and 365/);
  });
});

describe("session cookie", () => {
  it("signs and verifies an authority-bound session", () => {
    const session = new auth.SessionCodec(SECRET, MAX_AGE_MS, true);
    const issued = session.issue(
      { headers: { host: HOST } },
      { subject: "subject-1", email: "ada@example.com", name: "Ada" },
    );
    const pair = cookiePair(issued.header);

    expect(issued.name).toMatch(/^dsh-yawn-auth-/);
    expect(issued.header).toContain("HttpOnly");
    expect(issued.header).toContain("SameSite=Lax");
    expect(issued.header).toContain("Secure");

    expect(
      session.read({ headers: { host: HOST, cookie: pair } }),
    ).toMatchObject({
      subject: "subject-1",
      email: "ada@example.com",
      name: "Ada",
      authority: HOST,
    });
  });

  it("refuses a tampered, mis-scoped, or expired cookie", () => {
    let now = 1_000;
    const session = new auth.SessionCodec(SECRET, 1_000, false, () => now);
    const issued = session.issue(
      { headers: { host: HOST } },
      { subject: "subject-1" },
    );
    const pair = cookiePair(issued.header);

    const tampered = pair.slice(0, -1) + (pair.endsWith("A") ? "B" : "A");
    expect(
      session.read({ headers: { host: HOST, cookie: tampered } }),
    ).toBeUndefined();
    expect(
      session.read({
        headers: { host: "other.example.com", cookie: pair },
      }),
    ).toBeUndefined();

    now = 2_001;
    expect(
      session.read({ headers: { host: HOST, cookie: pair } }),
    ).toBeUndefined();
  });

  it("expires the cookie on logout", () => {
    const session = new auth.SessionCodec(SECRET, MAX_AGE_MS, false);
    expect(session.clear({ headers: { host: HOST } })).toContain("Max-Age=0");
  });
});

describe("sign-in flow", () => {
  it("redirects to the provider, then stores the session on callback", async () => {
    const { built, flow } = makeAuth();
    const started = await login(built);
    expect(started.reply.status).toBe(303);
    expect(started.state).not.toBe("");

    const finished = await callback(built, started.state, started.cookie);
    expect(finished.status).toBe(303);
    expect(finished.headers["location"]).toBe("/");
    const setCookie = finished.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const pair = cookiePair(setCookie!);

    expect(flow.calls.map((call) => call.kind)).toEqual([
      "authorization",
      "exchange",
    ]);
    expect(built.isSignedIn({ headers: { host: HOST, cookie: pair } })).toBe(
      true,
    );
  });

  it("refuses an email outside the allowed domains", async () => {
    const { built, flow } = makeAuth();
    const started = await login(built);
    flow.identity = { subject: "subject-2", email: "eve@other.example" };

    const finished = await callback(built, started.state, started.cookie);
    expect(finished.status).toBe(403);
    expect(finished.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses an email the provider marks unverified", async () => {
    const { built, flow } = makeAuth();
    const started = await login(built);
    flow.identity = {
      subject: "subject-3",
      email: "ada@example.com",
      emailVerified: false,
    };

    const finished = await callback(built, started.state, started.cookie);
    expect(finished.status).toBe(403);
    expect(finished.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses a state that does not belong to this browser", async () => {
    const { built } = makeAuth();
    const started = await login(built);
    const finished = await callback(
      built,
      started.state,
      "dsh-yawn-auth-state=another-browser",
    );
    expect(finished.status).toBe(400);
    expect(finished.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses an unknown or expired state", async () => {
    const { built } = makeAuth();
    expect((await callback(built, "unknown", "")).status).toBe(400);

    let now = 0;
    const expiring = makeAuth({ now: () => now });
    const started = await login(expiring.built);
    now = 11 * 60_000;
    expect(
      (await callback(expiring.built, started.state, started.cookie)).status,
    ).toBe(400);
  });

  it("passes the provider error through as a failed sign-in", async () => {
    const { built } = makeAuth();
    const started = await login(built);
    const { res, reply } = replyResponse();
    await built.callback(
      incoming(
        `/dsh-yawn/auth/callback?state=${encodeURIComponent(started.state)}&error=access_denied`,
        { host: HOST, cookie: started.cookie },
      ),
      res,
    );
    expect(reply.status).toBe(400);
  });

  it("answers the readiness probe without a session", () => {
    const { built } = makeAuth();
    const { res, reply } = replyResponse();
    built.health(incoming("/dsh-yawn/auth/health"), res);
    expect(reply.status).toBe(200);
  });

  it("clears the cookie on logout", () => {
    const { built } = makeAuth();
    const { res, reply } = replyResponse();
    built.logout(incoming("/dsh-yawn/auth/logout", { host: HOST }), res);
    expect(reply.status).toBe(303);
    expect(reply.headers["set-cookie"]).toContain("Max-Age=0");
  });
});

class FakeConnection {
  readonly browserPeer = {
    id: "browser-peer",
  } as unknown as HostConnectionHandle["browserPeer"];
  admission: PeerAdmission = { rejection: 401 };
  indexAllowed = true;

  admit(_request: ConnectionTrustRequest): PeerAdmission {
    return this.admission;
  }

  authorizeIndex(
    _request: IncomingMessage,
    _response: ServerResponse,
  ): boolean {
    return this.indexAllowed;
  }

  authorizeConnect(
    _request: IncomingMessage,
    _response: ServerResponse,
  ): void {}

  authenticatedUrl(baseUrl: string): string {
    return `${baseUrl}?token=old`;
  }
}

describe("connection wrapping", () => {
  it("admits only requests with the session cookie", () => {
    const { built, session } = makeAuth();
    const connection = new FakeConnection();
    const undo = built.wrap(connection as unknown as HostConnectionHandle);

    expect(connection.admit({ headers: { host: HOST } })).toEqual({
      rejection: 401,
    });

    const issued = session.issue(
      { headers: { host: HOST } },
      { subject: "subject-1" },
    );
    const cookie = cookiePair(issued.header);
    expect(connection.admit({ headers: { host: HOST, cookie } })).toEqual({
      peer: connection.browserPeer,
    });

    connection.admission = { peer: connection.browserPeer };
    expect(connection.admit({ headers: { host: HOST } })).toEqual({
      rejection: 401,
    });

    connection.admission = { rejection: 403 };
    expect(connection.admit({ headers: { host: HOST } })).toEqual({
      rejection: 403,
    });

    undo();
    expect(connection.admit({ headers: { host: HOST } })).toEqual({
      rejection: 403,
    });
  });

  it("redirects the index without a session and hides the launch token", () => {
    const { built, session } = makeAuth();
    const connection = new FakeConnection();
    const undo = built.wrap(connection as unknown as HostConnectionHandle);

    const { res, reply } = replyResponse();
    expect(connection.authorizeIndex(incoming("/"), res)).toBe(false);
    expect(reply.status).toBe(303);
    expect(reply.headers["location"]).toBe(auth.AUTH_LOGIN_PATH);

    const issued = session.issue(
      { headers: { host: HOST } },
      { subject: "subject-1" },
    );
    expect(
      connection.authorizeIndex(
        incoming("/", { host: HOST, cookie: cookiePair(issued.header) }),
        replyResponse().res,
      ),
    ).toBe(true);
    expect(connection.authenticatedUrl("http://127.0.0.1:3000/")).toBe(
      "http://127.0.0.1:3000/",
    );

    const connect = replyResponse();
    connection.authorizeConnect(incoming("/connect"), connect.res);
    expect(connect.reply.status).toBe(401);

    undo();
  });
});
