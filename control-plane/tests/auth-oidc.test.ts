import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { OpenIdFlow, type AuthConfig } from "../src/auth.js";

interface MockProvider {
  issuer: string;
  server: Server;
  setEmail: (email: string) => void;
  setNonce: (value: string) => void;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function startProvider(): Promise<MockProvider> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid: "test-key",
    use: "sig",
    alg: "RS256",
  };
  let nonce = "";
  let email = "ada@example.com";
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://dsh.invalid");
    if (url.pathname === "/.well-known/openid-configuration") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}authorize`,
          token_endpoint: `${issuer}token`,
          jwks_uri: `${issuer}jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          scopes_supported: ["openid", "email", "profile"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
          code_challenge_methods_supported: ["S256"],
        }),
      );
      return;
    }
    if (url.pathname === "/jwks") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = new URLSearchParams(
          Buffer.concat(chunks).toString("utf8"),
        );
        if (
          body.get("client_id") !== "test-client" ||
          body.get("client_secret") !== "test-secret" ||
          body.get("code") !== "code-1"
        ) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        const now = Math.floor(Date.now() / 1000);
        const header = base64Url(
          JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" }),
        );
        const payload = base64Url(
          JSON.stringify({
            iss: issuer,
            sub: "subject-1",
            aud: "test-client",
            iat: now,
            exp: now + 300,
            nonce,
            email,
            email_verified: true,
            name: "Ada Lovelace",
          }),
        );
        const signature = sign(
          "RSA-SHA256",
          Buffer.from(`${header}.${payload}`),
          privateKey,
        ).toString("base64url");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: "access-token",
            token_type: "Bearer",
            expires_in: 300,
            id_token: `${header}.${payload}.${signature}`,
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock provider did not bind a TCP port");
  }
  const issuer = `http://127.0.0.1:${address.port}/`;
  return {
    issuer,
    server,
    setEmail(value) {
      email = value;
    },
    setNonce(value) {
      nonce = value;
    },
  };
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function config(issuer: string): AuthConfig {
  return {
    issuer: new URL(issuer),
    clientId: "test-client",
    clientSecret: "test-secret",
    redirectUrl: new URL(`${issuer}callback`),
    emailDomains: ["example.com"],
    scopes: "openid email profile",
    cookieMaxAgeDays: 30,
    secureCookies: false,
    clientAuthMethod: "client_secret_post",
    allowInsecureRequests: true,
  };
}

describe("OpenIdFlow", () => {
  it("builds the authorization URL with state, nonce, and PKCE", async () => {
    const provider = await startProvider();
    const flow = new OpenIdFlow(config(provider.issuer));

    const authorizationUrl = new URL(
      await flow.authorizationUrl({
        state: "state-1",
        nonce: "nonce-1",
        codeChallenge: "challenge-1",
      }),
    );
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      `${provider.issuer}authorize`,
    );
    expect(authorizationUrl.searchParams.get("state")).toBe("state-1");
    expect(authorizationUrl.searchParams.get("nonce")).toBe("nonce-1");
    expect(authorizationUrl.searchParams.get("code_challenge")).toBe(
      "challenge-1",
    );
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe("test-client");
  });

  it("exchanges a code and returns the verified identity", async () => {
    const provider = await startProvider();
    provider.setNonce("nonce-1");
    const flow = new OpenIdFlow(config(provider.issuer));

    const identity = await flow.exchange({
      currentUrl: new URL(
        `${provider.issuer}callback?code=code-1&state=state-1`,
      ),
      state: "state-1",
      nonce: "nonce-1",
      codeVerifier: "verifier-1",
    });
    expect(identity).toEqual({
      subject: "subject-1",
      email: "ada@example.com",
      emailVerified: true,
      name: "Ada Lovelace",
    });
  });
});
