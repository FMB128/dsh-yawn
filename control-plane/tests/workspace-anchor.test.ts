import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createRepositoryAnchor,
  httpsRepositoryUrl,
  normalizeWorkspaceRepositoryUrl,
  repositoryForAnchor,
  repositoryTitle,
} from "../src/workspace-anchor.js";

describe("workspace anchors", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-yawn-control-plane-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("normalizes workspace repository URLs and titles", () => {
    expect(
      normalizeWorkspaceRepositoryUrl(" git@github.com:example/repo.git "),
    ).toBe("https://github.com/example/repo");
    expect(
      normalizeWorkspaceRepositoryUrl("git@gitlab.com:example/repo.git"),
    ).toBe("git@gitlab.com:example/repo");
    expect(repositoryTitle("https://github.com/example/repo")).toBe(
      "example/repo",
    );
    expect(() =>
      normalizeWorkspaceRepositoryUrl("https://user:secret@example.com/repo"),
    ).toThrow("password");
    expect(() =>
      normalizeWorkspaceRepositoryUrl("https://token@example.com/repo"),
    ).toThrow("credentials");
    expect(() =>
      normalizeWorkspaceRepositoryUrl(
        "git@example.com:owner/repo?token=secret",
      ),
    ).toThrow("query or fragment");
    expect(() =>
      normalizeWorkspaceRepositoryUrl("file:///home/user/repo"),
    ).toThrow("HTTPS");
  });

  it("creates one durable host anchor per repository", async () => {
    const [first, second] = await Promise.all([
      createRepositoryAnchor(
        directory,
        "https://github.com/example/public.git",
      ),
      createRepositoryAnchor(directory, "https://github.com/example/public"),
    ]);
    const different = await createRepositoryAnchor(
      directory,
      "https://github.com/example/other",
    );

    expect(second).toEqual(first);
    expect(different.path).not.toBe(first.path);
    expect(first.title).toBe("example/public");
    expect(await repositoryForAnchor(directory, first.path)).toBe(
      "https://github.com/example/public",
    );
    expect(await repositoryForAnchor(directory, directory)).toBeUndefined();
    expect((await stat(first.path)).mode & 0o777).toBe(0o700);
    expect((await stat(join(first.path, "repository.json"))).mode & 0o777).toBe(
      0o600,
    );
  });

  it("converts SSH repository URLs to HTTPS for new anchors", () => {
    expect(httpsRepositoryUrl("git@git.fml128.ch:FML128/repo.git")).toBe(
      "https://git.fml128.ch/FML128/repo.git",
    );
    expect(httpsRepositoryUrl("ssh://git@git.fml128.ch/FML128/repo.git")).toBe(
      "https://git.fml128.ch/FML128/repo.git",
    );
    expect(httpsRepositoryUrl("https://git.fml128.ch/FML128/repo")).toBe(
      "https://git.fml128.ch/FML128/repo",
    );
    expect(() =>
      httpsRepositoryUrl("ssh://git@git.fml128.ch:8443/FML128/repo.git"),
    ).toThrow("HTTPS");
    expect(() => httpsRepositoryUrl("git://git.fml128.ch/FML128/repo")).toThrow(
      "HTTPS",
    );
    expect(() =>
      httpsRepositoryUrl("http://git.fml128.ch/FML128/repo"),
    ).toThrow("HTTPS");
    expect(() =>
      httpsRepositoryUrl("ssh://git:secret@git.fml128.ch/FML128/repo"),
    ).toThrow("password");
  });

  it("creates a new anchor from the HTTPS form of an SSH URL", async () => {
    const anchor = await createRepositoryAnchor(
      directory,
      "git@git.fml128.ch:FML128/repo.git",
    );

    expect(anchor.repositoryUrl).toBe("https://git.fml128.ch/FML128/repo");
    expect(await repositoryForAnchor(directory, anchor.path)).toBe(
      "https://git.fml128.ch/FML128/repo",
    );
  });
});
