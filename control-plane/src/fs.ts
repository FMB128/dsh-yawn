import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";

import { Code, ConnectError } from "@connectrpc/connect";
import type { Context } from "@deepseek-ai/cordis";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import {
  FileSystem,
  FsError,
  FsTargetKey,
  FsVersion,
  type FsDirEntry,
  type FsEditOutcome,
  type FsEditRequest,
  type FsInfo,
  type FsPathInfo,
  type FsTarget,
  type FsWriteIntent,
  type FsWriteOutcome,
} from "@deepseek-ai/dsh-fs";

import {
  AttachmentCopies,
  collectFileAttachments,
  type FileAttachmentRef,
} from "./attachment-copies.js";
import { bootstrapPathInSandbox } from "./ptc/bootstrap.js";
import { FileType } from "./gen/dsh/yawn/v1/runner_pb.js";
import { pathInSandbox } from "./sandbox-path.js";

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const MAX_TEXT_BYTES = 64 * 1024 * 1024;

export class SandboxFileSystem extends FileSystem {
  static inject = ["sandboxManager", "agents"];

  private readonly attachmentCopies: AttachmentCopies;

  constructor(ctx: Context) {
    super(ctx);
    this.attachmentCopies = new AttachmentCopies({
      workspace: () => ctx.sandboxManager.workspace,
      sessionKey: () => ctx.sandboxManager.rootSessionIdForCurrentAgent(),
      client: () => ctx.sandboxManager.clientForCurrentAgent(),
      hostPath: (ref) => attachmentsOf(ctx)?.fileHostPath(ref),
      readBytes: (hostPath, signal) =>
        readFile(hostPath, signal === undefined ? {} : { signal }),
      warn: (message) =>
        ctx.logger("sandbox").warn(`attachment copy: ${message}`),
    });
    ctx.on("llm/stream", (options, next) =>
      this.copyAttachmentsThenStream(options, next),
    );
  }

  async resolve(
    path: string,
    options?: { cwd?: string; signal?: AbortSignal },
  ): Promise<FsTarget> {
    if (path.trim().length === 0) {
      throw new FsError("file path must not be empty", "FS_NOT_FOUND");
    }
    try {
      const sessionWorkspace =
        this.ctx.agents.requireInitiator().session.header.cwd;
      const sandboxWorkspace = this.ctx.sandboxManager.workspace;
      const client = await this.ctx.sandboxManager.clientForCurrentAgent();
      const result = await client.resolvePath(
        {
          path: pathInSandbox(path, sessionWorkspace, sandboxWorkspace),
          cwd: pathInSandbox(
            options?.cwd ?? sandboxWorkspace,
            sessionWorkspace,
            sandboxWorkspace,
          ),
        },
        signalOptions(options?.signal),
      );
      return {
        targetKey: FsTargetKey(result.canonicalPath),
        displayPath: result.displayPath,
      };
    } catch (error) {
      throw mapFileError(error, "resolve", path, options?.signal);
    }
  }

  processPath(target: FsTarget): string {
    return String(target.targetKey);
  }

  fileUrl(target: FsTarget): string {
    return pathToFileURL(this.processPath(target)).href;
  }

  /**
   * Map a host file this backend placed in the sandbox: the attachment copy a
   * request already made, or the PTC bootstrap copied in before the program that
   * needs it starts. Synchronous by contract and called
   * during request assembly, so it never does I/O and never throws; an unknown
   * path stays unmapped and the caller keeps its own placeholder for it.
   */
  processPathFromHostPath(hostPath: string): string | undefined {
    return (
      this.attachmentCopies.lookup(hostPath) ?? bootstrapPathInSandbox(hostPath)
    );
  }

  contains(parent: FsTarget, child: FsTarget): boolean {
    const relative = posix.relative(
      this.processPath(parent),
      this.processPath(child),
    );
    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith("../") &&
        !posix.isAbsolute(relative))
    );
  }

  async stat(
    target: FsTarget,
    signal?: AbortSignal,
  ): Promise<FsInfo | undefined> {
    try {
      const client = await this.ctx.sandboxManager.clientForCurrentAgent();
      const result = await client.stat(
        { path: this.processPath(target), followSymlinks: true },
        signalOptions(signal),
      );
      if (!result.exists) {
        return undefined;
      }
      return {
        version: FsVersion(result.version),
        type: fsType(result.type),
        ...(result.type === FileType.REGULAR
          ? { size: safeNumber(result.size) }
          : {}),
      };
    } catch (error) {
      throw mapFileError(error, "stat", target.displayPath, signal);
    }
  }

  async lstat(
    path: string,
    options?: { cwd?: string },
    signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    const target = await this.resolve(path, {
      ...options,
      ...(signal === undefined ? {} : { signal }),
    });
    try {
      const client = await this.ctx.sandboxManager.clientForCurrentAgent();
      const result = await client.stat(
        { path: target.displayPath, followSymlinks: false },
        signalOptions(signal),
      );
      if (!result.exists) {
        return undefined;
      }
      return {
        version: FsVersion(result.version),
        type: pathType(result.type),
        ...(result.type === FileType.REGULAR
          ? { size: safeNumber(result.size) }
          : {}),
      };
    } catch (error) {
      throw mapFileError(error, "lstat", target.displayPath, signal);
    }
  }

  async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const bytes = await this.readBytes(target, signal, MAX_TEXT_BYTES);
    return decodeText(bytes, target.displayPath);
  }

  async streamText(
    target: FsTarget,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<string>> {
    const text = await this.readText(target, signal);
    return {
      async *[Symbol.asyncIterator]() {
        yield text;
      },
    };
  }

  async readBytes(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<Uint8Array> {
    try {
      const client = await this.ctx.sandboxManager.clientForCurrentAgent();
      const result = await client.readFile(
        { path: this.processPath(target), maxBytes: BigInt(maxBytes) },
        signalOptions(signal),
      );
      return result.content;
    } catch (error) {
      throw mapFileError(error, "read", target.displayPath, signal);
    }
  }

  async readByteRange(
    target: FsTarget,
    range: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    try {
      const client = await this.ctx.sandboxManager.clientForCurrentAgent();
      const result = await client.readFileRange(
        {
          path: this.processPath(target),
          offset: BigInt(range.offset),
          length: BigInt(range.length),
        },
        signalOptions(signal),
      );
      return result.content;
    } catch (error) {
      throw mapFileError(error, "read", target.displayPath, signal);
    }
  }

  async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    try {
      const client = await this.ctx.sandboxManager.clientForCurrentAgent();
      const result = await client.list(
        this.processPath(target),
        signalOptions(signal),
      );
      return result.entries.map((entry) => ({
        name: entry.name,
        type: fsType(entry.type),
        target: {
          targetKey: FsTargetKey(entry.canonicalPath),
          displayPath: posix.join(target.displayPath, entry.name),
        },
        version: FsVersion(entry.version),
        ...(entry.type === FileType.REGULAR
          ? { size: safeNumber(entry.size) }
          : {}),
      }));
    } catch (error) {
      throw mapFileError(error, "list", target.displayPath, signal);
    }
  }

  async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    try {
      const client = await this.ctx.sandboxManager.clientForCurrentAgent();
      const result = await client.writeFile(
        {
          path: this.processPath(target),
          content: new TextEncoder().encode(content),
          guard:
            expected?.kind === "createIfAbsent"
              ? { case: "createIfAbsent", value: true }
              : expected?.kind === "replaceIfVersion"
                ? { case: "expectedVersion", value: String(expected.version) }
                : { case: undefined },
        },
        signalOptions(signal),
      );
      return {
        operation: result.created ? "create" : "update",
        version: FsVersion(result.version),
        before: result.hadBefore
          ? normalizeLineEndings(decodeText(result.before, target.displayPath))
          : null,
        after: normalizeLineEndings(content),
      };
    } catch (error) {
      throw mapFileError(error, "write", target.displayPath, signal);
    }
  }

  async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: ReturnType<typeof FsVersion> },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    if (edit.oldString.length === 0) {
      throw new FsError("old_string must not be empty", "FS_EDIT_NOT_FOUND");
    }
    try {
      const client = await this.ctx.sandboxManager.clientForCurrentAgent();
      const result = await client.editFile(
        {
          path: this.processPath(target),
          oldString: edit.oldString,
          newString: edit.newString,
          replaceAll: edit.replaceAll,
          expectedVersion:
            expected === undefined ? "" : String(expected.version),
        },
        signalOptions(signal),
      );
      return {
        version: FsVersion(result.version),
        before: normalizeLineEndings(
          decodeText(result.before, target.displayPath),
        ),
        after: normalizeLineEndings(
          decodeText(result.after, target.displayPath),
        ),
      };
    } catch (error) {
      throw mapFileError(error, "edit", target.displayPath, signal);
    }
  }

  /**
   * Copy the request's attachments into the sandbox before request assembly
   * resolves their handle text. The generator defers the copy to first
   * iteration, which still runs before `next()` and so before the projection
   * that asks `processPathFromHostPath` for each reference.
   */
  private async *copyAttachmentsThenStream(
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
  ): AsyncGenerator<StreamChunk> {
    await this.attachmentCopies.ensure(
      collectFileAttachments(options.messages),
      options.signal,
    );
    yield* next();
  }
}

/** The attachment fields this module reads; dsh owns the service surface. */
interface AttachmentsLookup {
  fileHostPath(ref: FileAttachmentRef): string | undefined;
}

function attachmentsOf(ctx: Context): AttachmentsLookup | undefined {
  return ctx.get("attachments");
}

function mapFileError(
  error: unknown,
  operation: string,
  path: string,
  signal?: AbortSignal,
): FsError {
  if (error instanceof FsError) {
    return error;
  }
  if (signal?.aborted === true) {
    return new FsError(`${operation} aborted`, "FS_ABORTED", { cause: error });
  }
  const connect = ConnectError.from(error);
  const message = connect.rawMessage.toLowerCase();
  let code: ConstructorParameters<typeof FsError>[1] = "FS_IO_ERROR";
  if (connect.code === Code.NotFound) {
    code = message.includes("old_string")
      ? "FS_EDIT_NOT_FOUND"
      : "FS_NOT_FOUND";
  } else if (connect.code === Code.PermissionDenied) {
    code = "FS_PERMISSION_DENIED";
  } else if (connect.code === Code.ResourceExhausted) {
    code = "FS_TOO_LARGE";
  } else if (connect.code === Code.AlreadyExists) {
    code = "FS_NOT_OBSERVED";
  } else if (connect.code === Code.FailedPrecondition) {
    code = message.includes("ambiguous")
      ? "FS_AMBIGUOUS_EDIT"
      : "FS_STALE_VERSION";
  } else if (connect.code === Code.Canceled) {
    code = "FS_ABORTED";
  }
  return new FsError(
    `cannot ${operation} "${path}": ${connect.rawMessage}`,
    code,
    { cause: error },
  );
}

function decodeText(bytes: Uint8Array, path: string): string {
  if (bytes.subarray(0, 8192).includes(0)) {
    throw new FsError(`cannot read "${path}": binary file`, "FS_NOT_TEXT");
  }
  try {
    return textDecoder.decode(bytes);
  } catch (error) {
    throw new FsError(`cannot read "${path}": invalid UTF-8`, "FS_NOT_TEXT", {
      cause: error,
    });
  }
}

function fsType(type: FileType): "file" | "directory" | "other" {
  if (type === FileType.REGULAR) {
    return "file";
  }
  if (type === FileType.DIRECTORY) {
    return "directory";
  }
  return "other";
}

function pathType(type: FileType): "file" | "directory" | "symlink" | "other" {
  if (type === FileType.SYMLINK) {
    return "symlink";
  }
  return fsType(type);
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

function signalOptions(signal?: AbortSignal): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

function safeNumber(value: bigint): number {
  return Number(
    value > BigInt(Number.MAX_SAFE_INTEGER)
      ? BigInt(Number.MAX_SAFE_INTEGER)
      : value,
  );
}

export default SandboxFileSystem;
