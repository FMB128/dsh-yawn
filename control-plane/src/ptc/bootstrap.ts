/**
 * The PTC Node backend's bootstrap, placed in the sandbox.
 *
 * `@deepseek-ai/dsh-ptc-runtime-node` runs each model-written program in a
 * fresh Node child inside the session's sandbox, and resolves its bootstrap
 * through `ctx.fs.processPathFromHostPath` — dsh's filesystem service asking
 * how to name this absolute host file in the execution world. The provider's
 * own copy is a control-plane path no sandbox has, so this module answers with
 * a sandbox path and copies the file in before the program starts.
 *
 * The two halves cannot be one step: the hook is synchronous by contract (it
 * runs during request assembly and never does I/O), while the copy is a runner
 * call that happens once the command's coordinates are known.
 *
 * @module @zhming0/dsh-yawn/ptc/bootstrap
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";

import type { RunnerClient } from "../runner-client.js";

/**
 * The bootstrap inside the provider's own package. Matching the whole tail
 * rather than the basename is what keeps this mapping from claiming unrelated
 * host files; the layout is the pinned dsh release's, and a release that moves
 * the file leaves the provider's own "bootstrap is unavailable in the
 * subprocess execution world" error in place.
 */
const HOST_PATH_SUFFIX = "@deepseek-ai/dsh-ptc-runtime-node/lib/process.js";

/**
 * Where the copies live in a sandbox: the workspace volume's bookkeeping
 * directory, beside the runner's apt cache and outside the repository
 * checkout, so a session never sees them and a wake keeps them. One directory
 * per source path, so a control plane that maps more than one installed copy
 * cannot hand a command the other's bytes.
 */
const SANDBOX_DIRECTORY = "/workspace/.dsh-yawn/ptc-runtime-node";

/** Sandbox bootstrap path -> the control-plane file it was mapped from. */
const sources = new Map<string, string>();

/**
 * Map the provider's bootstrap into the sandbox, or undefined for a host path
 * this mapping does not own. Called while a model request is assembled.
 */
export function bootstrapPathInSandbox(hostPath: string): string | undefined {
  // A control plane on Windows resolves the file with backslashes, and the
  // sandbox is always a POSIX machine.
  const normalized = hostPath.replaceAll("\\", "/");
  if (!normalized.endsWith(HOST_PATH_SUFFIX)) {
    return undefined;
  }
  const tag = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 12);
  const path = posix.join(SANDBOX_DIRECTORY, tag, "process.js");
  sources.set(path, hostPath);
  return path;
}

/**
 * True for a sandbox path this mapping owns. The subprocess run checks it before
 * translating argv: such a path is already in sandbox coordinates, and a session
 * anchor that sits above the workspace would otherwise rewrite it.
 */
export function isMappedBootstrap(path: string): boolean {
  return sources.has(path);
}

/**
 * Copy one mapped bootstrap into the sandbox, if the path is one. The bytes come
 * from the control plane's own installed package every time, so a sandbox that
 * outlives a control-plane upgrade can never keep running the release it was
 * given first.
 */
export async function placeBootstrap(
  client: RunnerClient,
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  const source = sources.get(path);
  if (source === undefined) {
    // Not an asset of ours: most argv elements are ordinary paths. A path that
    // looks like a bootstrap but was never mapped reaches the child as it is,
    // and the provider's own module-not-found error names it.
    return;
  }
  await client.writeFile(
    {
      path,
      // The copy replaces whatever a previous control plane left there.
      content: await readFile(source),
      guard: { case: undefined },
    },
    signal === undefined ? {} : { signal },
  );
}
