import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { expect, it } from "vitest";

import { apply, name } from "../src/owns-host.js";

/**
 * The owns-host row works through two seams inside the pinned dsh packages.
 * If a dsh bump moves either one, this test fails in the same change that
 * bumps the pin, naming what to re-verify instead of letting the injected
 * global silently stop mattering.
 *
 * 1. dsh-client-connection reads `globalThis.__DSH_TRANSPORT__` before any
 *    module batch runs and derives the connection handle's `isLoopback` from
 *    `transport?.ownsHost === true` ahead of the page-hostname fallback.
 * 2. dsh-api-gateway's `remote.$host` getter copies
 *    `this.connection.isLoopback`, which is what the settings packages
 *    branch on when they choose host persistence over browser memory.
 */
const SEAM_PACKAGE_FILES: ReadonlyArray<[string, RegExp, string]> = [
  [
    "@deepseek-ai/dsh-client-connection",
    /__DSH_TRANSPORT__/,
    "the client no longer reads a __DSH_TRANSPORT__ global",
  ],
  [
    "@deepseek-ai/dsh-client-connection",
    /ownsHost/,
    "the connection handle no longer honors transport.ownsHost",
  ],
  [
    "@deepseek-ai/dsh-api-gateway",
    /isLoopback:\s*this\.connection\.isLoopback/,
    "remote.$host no longer copies connection.isLoopback",
  ],
];

const require = createRequire(import.meta.url);

/** The file a package's `./client` export serves to the browser. */
function browserBundle(packageName: string): string {
  const manifestPath = require.resolve(`${packageName}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    exports: Record<string, string | Record<string, string>>;
  };
  const client = manifest.exports["./client"];
  const file =
    typeof client === "string" ? client : (client?.browser ?? client?.default);
  if (file === undefined) {
    throw new Error(`${packageName} exports no "./client" bundle`);
  }
  return join(manifestPath, "..", file);
}

it("is named and shaped like the other rows", () => {
  expect(name).toBe("ui-owns-host");
  expect(typeof apply).toBe("function");
});

it("pushes the ownsHost global onto the index injection table", () => {
  const listeners = new Map<string, (table: unknown[]) => void>();
  let disposed = false;
  const scope = {
    effect: (register: () => () => void) => register(),
    on: (event: string, listener: (table: unknown[]) => void) => {
      listeners.set(event, listener);
      return () => {
        disposed = true;
      };
    },
  };
  const injects: string[][] = [];

  apply({
    inject: (names: string[], ready: (scoped: unknown) => void) => {
      injects.push(names);
      ready(scope);
    },
  } as unknown as Parameters<typeof apply>[0]);

  expect(injects).toEqual([["webServer"]]);
  const listener = listeners.get("webserver/index-inject");
  expect(listener).toBeDefined();

  const table: unknown[] = [];
  listener?.(table);
  expect(table).toEqual([
    { kind: "global", name: "__DSH_TRANSPORT__", value: { ownsHost: true } },
  ]);
  expect(disposed).toBe(false);
});

it("still holds the two seams in the pinned dsh packages", () => {
  for (const [packageName, pattern, diagnosis] of SEAM_PACKAGE_FILES) {
    const text = readFileSync(browserBundle(packageName), "utf8");
    expect(pattern.test(text), diagnosis).toBe(true);
  }
});
