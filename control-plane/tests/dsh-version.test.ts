import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

function manifest(): Record<string, Record<string, string> | undefined> {
  return JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as Record<string, Record<string, string> | undefined>;
}

/**
 * The control-plane image derives the dsh launcher version from the
 * `@deepseek-ai/dsh-agent` pin, so that derivation only has one possible
 * answer when every dsh pin in this manifest agrees.
 */
it("pins every @deepseek-ai/dsh-* dependency to one version", () => {
  const pins = new Map<string, string>();
  for (const group of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const [name, range] of Object.entries(manifest()[group] ?? {})) {
      if (!name.startsWith("@deepseek-ai/dsh-")) {
        continue;
      }
      pins.set(`${group} > ${name}`, range.replace(/^\^/, ""));
    }
  }

  expect(pins.size).toBeGreaterThan(0);
  expect(new Set(pins.values()).size, JSON.stringify([...pins], null, 2)).toBe(
    1,
  );
});

/**
 * The runner image ships the PTC Node backend's bootstrap, and the bundle patch
 * points the provider at that copy. A bootstrap from another dsh release fails
 * the control handshake at the first frame, so it is pinned to the release the
 * control plane runs. The runner image builds from its own context and cannot
 * read this manifest, which is why a test guards the pair.
 */
it("pins the runner image's PTC bootstrap to the same dsh version", () => {
  const pin = manifest().peerDependencies?.["@deepseek-ai/dsh-agent"];
  expect(pin).toBeDefined();
  const dockerfile = readFileSync(
    new URL("../../runner/Dockerfile", import.meta.url),
    "utf8",
  );
  const declared = /^ARG DSH_PTC_RUNTIME_VERSION=(\S+)$/m.exec(dockerfile);
  expect(declared?.[1]).toBe(pin);
});
