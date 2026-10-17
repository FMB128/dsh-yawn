import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";
import { parse } from "yaml";

const run = promisify(execFile);

/**
 * The bundle patch disables `harness-dev-context`, the dsh row that tells the
 * model the host's checkout path and Web GUI URL. A patch entry for a row id
 * that no longer exists is skipped with a warning, and the host-only text
 * would come back without any test failing. This downloads the pinned
 * dsh-web-app and checks that it still mounts that row under that module.
 * Requires registry access; that is the point — the tripwire fires in the
 * change that bumps the pin.
 */

async function pinnedDshVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { devDependencies: Record<string, string> };
  const version = manifest.devDependencies["@deepseek-ai/dsh-agent"];
  if (version === undefined) {
    throw new Error("control plane does not pin @deepseek-ai/dsh-agent");
  }
  return version;
}

interface Row {
  id?: string;
  name?: string;
  insert?: Row[];
}

function findRow(rows: Row[], id: string): Row | undefined {
  for (const row of rows) {
    if (row.id === id) {
      return row;
    }
    const inner =
      row.insert === undefined ? undefined : findRow(row.insert, id);
    if (inner !== undefined) {
      return inner;
    }
  }
  return undefined;
}

it("the pinned dsh-web-app still mounts the harness-dev-context row this bundle disables", async () => {
  const version = await pinnedDshVersion();
  const dir = await mkdtemp(join(tmpdir(), "dsh-host-prompt-row-"));
  try {
    await run(
      "npm",
      [
        "pack",
        `@deepseek-ai/dsh-web-app@${version}`,
        "--pack-destination",
        dir,
      ],
      { cwd: dir },
    );
    await run("tar", [
      "-xzf",
      join(dir, `deepseek-ai-dsh-web-app-${version}.tgz`),
      "-C",
      dir,
    ]);
    // `!!js` expressions are dsh's own tag; only ids and names matter here.
    const rows = parse(
      await readFile(join(dir, "package", "cordis.patch.yml"), "utf8"),
      { logLevel: "error" },
    ) as Row[];
    expect(
      findRow(rows, "harness-dev-context")?.name,
      `dsh-web-app ${version} no longer mounts harness-dev-context; find where ` +
        "it now composes the checkout and Web GUI prompt text, and update the " +
        "row this bundle disables in cordis.patch.yml",
    ).toBe("@deepseek-ai/dsh-harness-dev-context");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
