import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { Context } from "@deepseek-ai/cordis";
import * as connectionPlugin from "@deepseek-ai/dsh-client-connection";
import { describe, expect, it } from "vitest";

import * as passcodeAuth from "../src/passcode-auth.js";

const PASSCODE = "correct horse battery";

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
    setHeader(name: string, value: string) {
      out.headers[name] = value;
      return this;
    },
    end(body?: string) {
      out.body = body ?? "";
      return this;
    },
  } as unknown as ServerResponse;
}

function request(options: {
  method?: string;
  url?: string;
  body?: string;
  cookie?: string;
  host?: string;
}): IncomingMessage {
  const headers: Record<string, string> = {
    host: options.host ?? "localhost:3000",
  };
  if (options.cookie !== undefined) {
    headers.cookie = options.cookie;
  }
  if (options.body !== undefined) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    headers["content-length"] = String(Buffer.byteLength(options.body));
  }
  return Object.assign(
    Readable.from(
      options.body === undefined ? [] : [Buffer.from(options.body)],
    ),
    {
      method: options.method ?? "GET",
      url: options.url ?? "/",
      headers,
      socket: { remoteAddress: "127.0.0.1" },
    },
  ) as unknown as IncomingMessage;
}

/**
 * This test uses the real pinned `dsh-client-connection`, not a fake. The
 * passcode row's handoff depends on dsh accepting a root token request through
 * `connection.authorizeIndex` and minting a cookie that `connection.admit`
 * accepts; a dsh bump that moves either behavior must fail here.
 */
async function mount(): Promise<{
  ctx: Context;
  routes: Map<
    string,
    (request: IncomingMessage, response: ServerResponse) => unknown
  >;
}> {
  const ctx = new Context();
  const store = new Map<string, unknown>();
  const routes = new Map<
    string,
    (request: IncomingMessage, response: ServerResponse) => unknown
  >();
  ctx.provide("credentials", {
    async modifyRecord(
      key: unknown,
      update: (current: unknown) => Promise<unknown>,
    ): Promise<unknown> {
      const name = JSON.stringify(key);
      const next = await update(store.get(name));
      if (next !== undefined) {
        store.set(name, next);
      }
      return store.get(name);
    },
  });
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
    on() {
      return () => {};
    },
  });
  await ctx.plugin(connectionPlugin, { trustedHosts: [] });
  await ctx.plugin(passcodeAuth, { passcode: PASSCODE });
  return { ctx, routes };
}

describe("passcode auth against the pinned dsh connection", () => {
  it("mints a cookie through dsh's own exchange and admits it", async () => {
    const { ctx, routes } = await mount();
    try {
      const index = reply();
      expect(
        ctx.connection.authorizeIndex(request({}), response(index) as never),
      ).toBe(false);
      expect(index.status).toBe(303);
      expect(index.headers.location).toBe("/login");

      const login = reply();
      await routes.get("/login")?.(
        request({
          method: "POST",
          url: "/login",
          body: `passcode=${encodeURIComponent(PASSCODE)}`,
        }),
        response(login),
      );
      expect(login.status).toBe(303);
      expect(login.headers.location).toBe("/");
      const cookie = login.headers["set-cookie"]?.split(";")[0];
      expect(cookie).toBeDefined();

      const admission = ctx.connection.admit({
        headers: { host: "localhost:3000", cookie: cookie ?? "" },
      });
      expect("peer" in admission).toBe(true);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
