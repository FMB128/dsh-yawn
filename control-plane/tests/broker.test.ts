import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CredentialBroker,
  GLOBAL_SECRET_SCOPE,
  normalizeRepositoryUrl,
  type SecretScope,
} from "../src/broker.js";

/** One workspace scope, as the manager builds it from a registered anchor. */
function workspace(repositoryUrl: string): SecretScope {
  return { kind: "workspace", repositoryUrl };
}

describe("credential broker", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-yawn-control-plane-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("stores secret names without exposing values in listings", async () => {
    const broker = new CredentialBroker({
      path: join(directory, "broker.json"),
    });
    await broker.initialize();
    await broker.setSecret(GLOBAL_SECRET_SCOPE, "API_KEY", "secret-value");
    expect(broker.secretNames(GLOBAL_SECRET_SCOPE)).toEqual(["API_KEY"]);
    expect(broker.secrets(GLOBAL_SECRET_SCOPE)).toEqual({
      API_KEY: "secret-value",
    });
    await expect(
      broker.setSecret(GLOBAL_SECRET_SCOPE, "not-valid-name", "x"),
    ).rejects.toThrow("invalid");
  });

  it("serves a GITHUB_TOKEN secret as the github.com git credential", async () => {
    const broker = new CredentialBroker({
      path: join(directory, "broker.json"),
    });
    await broker.initialize();

    // No GITHUB_TOKEN secret: no credential.
    expect(
      await broker.gitCredentials("https://github.com/example/repo.git"),
    ).toEqual([]);

    await broker.setSecret(GLOBAL_SECRET_SCOPE, "GITHUB_TOKEN", "pat-value");
    expect(
      await broker.gitCredentials("https://github.com/example/repo.git"),
    ).toEqual([
      {
        host: "github.com",
        username: "x-access-token",
        password: "pat-value",
      },
    ]);

    // A workspace hosted elsewhere still gets the github.com credential.
    expect(
      await broker.gitCredentials("https://gitlab.com/example/repo.git"),
    ).toEqual([
      {
        host: "github.com",
        username: "x-access-token",
        password: "pat-value",
      },
    ]);
  });

  it("serves host-shaped token secrets as credentials for other forges", async () => {
    const broker = new CredentialBroker({
      path: join(directory, "broker.json"),
    });
    await broker.initialize();
    await broker.setSecret(
      GLOBAL_SECRET_SCOPE,
      "GIT_EXAMPLE_COM_TOKEN",
      "forge-pat",
    );
    await broker.setSecret(
      GLOBAL_SECRET_SCOPE,
      "GITLAB_COM_TOKEN",
      "gitlab-pat",
    );
    await broker.setSecret(
      GLOBAL_SECRET_SCOPE,
      "codeberg_org_token",
      "code-pat",
    );
    // Names that do not spell a multi-label host stay plain secrets.
    await broker.setSecret(GLOBAL_SECRET_SCOPE, "NPM_TOKEN", "npm-token");
    await broker.setSecret(GLOBAL_SECRET_SCOPE, "NOT_A_TOKEN_NAME", "other");

    expect(
      await broker.gitCredentials("https://git.example.com/example/repo"),
    ).toEqual([
      { host: "git.example.com", username: "oauth2", password: "forge-pat" },
      { host: "gitlab.com", username: "oauth2", password: "gitlab-pat" },
      { host: "codeberg.org", username: "oauth2", password: "code-pat" },
    ]);
  });

  it("keeps one credential per host and prefers the workspace scope", async () => {
    const broker = new CredentialBroker({
      path: join(directory, "broker.json"),
    });
    await broker.initialize();
    const repository = "https://git.example.com/example/repo";
    await broker.setSecret(GLOBAL_SECRET_SCOPE, "GITHUB_TOKEN", "pat-value");
    await broker.setSecret(
      GLOBAL_SECRET_SCOPE,
      "GIT_EXAMPLE_COM_TOKEN",
      "global-forge",
    );
    // A spelling of github.com that would otherwise add a second entry.
    await broker.setSecret(GLOBAL_SECRET_SCOPE, "GITHUB_COM_TOKEN", "shadowed");
    await broker.setSecret(
      workspace(repository),
      "GIT_EXAMPLE_COM_TOKEN",
      "workspace-forge",
    );

    expect(await broker.gitCredentials(repository)).toEqual([
      {
        host: "github.com",
        username: "x-access-token",
        password: "pat-value",
      },
      {
        host: "git.example.com",
        username: "oauth2",
        password: "workspace-forge",
      },
    ]);
    // Another workspace gets the global forge token, not this one's.
    expect(await broker.gitCredentials("https://gitlab.com/a/b")).toEqual([
      {
        host: "github.com",
        username: "x-access-token",
        password: "pat-value",
      },
      { host: "git.example.com", username: "oauth2", password: "global-forge" },
    ]);
  });

  it("scopes secrets per workspace with same-name override", async () => {
    const broker = new CredentialBroker({
      path: join(directory, "broker.json"),
    });
    await broker.initialize();
    await broker.setSecret(GLOBAL_SECRET_SCOPE, "API_KEY", "global");
    await broker.setSecret(
      workspace("https://github.com/a/x"),
      "API_KEY",
      "workspace",
    );
    await broker.setSecret(
      workspace("https://github.com/a/x"),
      "EXTRA",
      "workspace-only",
    );

    expect(broker.secretNames(GLOBAL_SECRET_SCOPE)).toEqual(["API_KEY"]);
    expect(broker.secretNames(workspace("https://github.com/a/x"))).toEqual([
      "API_KEY",
      "EXTRA",
    ]);
    expect(broker.secretNames(workspace("https://github.com/a/y"))).toEqual([]);
    expect(broker.secrets(GLOBAL_SECRET_SCOPE)).toEqual({ API_KEY: "global" });
    expect(broker.secrets(workspace("https://github.com/a/x"))).toEqual({
      API_KEY: "workspace",
      EXTRA: "workspace-only",
    });
    expect(broker.secrets(workspace("https://github.com/a/y"))).toEqual({
      API_KEY: "global",
    });
    await expect(
      broker.setSecret(workspace("https://github.com/a/x"), "not-valid!", "x"),
    ).rejects.toThrow("invalid");

    // Deleting the last workspace secret drops the workspace section.
    await broker.deleteSecret(workspace("https://github.com/a/x"), "EXTRA");
    await broker.deleteSecret(workspace("https://github.com/a/x"), "API_KEY");
    expect(broker.secretNames(workspace("https://github.com/a/x"))).toEqual([]);
    expect(broker.secretNames(GLOBAL_SECRET_SCOPE)).toEqual(["API_KEY"]);
    const saved = JSON.parse(
      await readFile(join(directory, "broker.json"), "utf8"),
    ) as { workspaces: Record<string, unknown> };
    expect(saved.workspaces).toEqual({});
  });

  it("keys a workspace by the repository, not by a clone-URL spelling", async () => {
    const broker = new CredentialBroker({
      path: join(directory, "broker.json"),
    });
    await broker.initialize();
    await broker.setSecret(
      workspace("git@github.com:a/x.git"),
      "TOKEN",
      "scp-spelling",
    );

    // Reads through any spelling of the same repository see the same scope.
    for (const spelling of [
      "https://github.com/a/x",
      "https://github.com/a/x.git",
      "https://github.com/a/x/",
      "ssh://git@github.com/a/x.git",
      "https://GitHub.com/a/x?tab=readme",
    ]) {
      expect(broker.secrets(workspace(spelling))).toMatchObject({
        TOKEN: "scp-spelling",
      });
      expect(broker.secretNames(workspace(spelling))).toEqual(["TOKEN"]);
    }
    expect(broker.secrets(workspace("https://github.com/a/y"))).toEqual({});

    // A write through one spelling lands in the one stored scope.
    await broker.setSecret(
      workspace("https://github.com/a/x.git"),
      "NEXT",
      "1",
    );
    const saved = JSON.parse(
      await readFile(join(directory, "broker.json"), "utf8"),
    ) as { workspaces: Record<string, Record<string, string>> };
    expect(Object.keys(saved.workspaces)).toEqual(["https://github.com/a/x"]);
    expect(saved.workspaces["https://github.com/a/x"]).toEqual({
      TOKEN: "scp-spelling",
      NEXT: "1",
    });
  });

  it("prefers a workspace GITHUB_TOKEN for that workspace's clones", async () => {
    const broker = new CredentialBroker({
      path: join(directory, "broker.json"),
    });
    await broker.initialize();
    await broker.setSecret(GLOBAL_SECRET_SCOPE, "GITHUB_TOKEN", "global-pat");
    await broker.setSecret(
      workspace("https://github.com/example/repo"),
      "GITHUB_TOKEN",
      "workspace-pat",
    );

    expect(
      await broker.gitCredentials("https://github.com/example/repo"),
    ).toEqual([
      {
        host: "github.com",
        username: "x-access-token",
        password: "workspace-pat",
      },
    ]);
    expect(
      await broker.gitCredentials("https://github.com/other/repo"),
    ).toEqual([
      {
        host: "github.com",
        username: "x-access-token",
        password: "global-pat",
      },
    ]);
  });

  it("reads a version 1 file as global-only and writes version 2", async () => {
    const path = join(directory, "broker.json");
    await writeFile(
      path,
      `${JSON.stringify({
        version: 1,
        secrets: { LEGACY: "kept" },
      })}\n`,
      "utf8",
    );
    const broker = new CredentialBroker({ path });
    await broker.initialize();

    expect(broker.secretNames(GLOBAL_SECRET_SCOPE)).toEqual(["LEGACY"]);
    expect(broker.secrets(workspace("https://github.com/a/x"))).toEqual({
      LEGACY: "kept",
    });
    await broker.setSecret(GLOBAL_SECRET_SCOPE, "NEW", "value");
    const saved = JSON.parse(await readFile(path, "utf8")) as {
      version: number;
      workspaces: Record<string, unknown>;
    };
    expect(saved.version).toBe(2);
    expect(saved.workspaces).toEqual({});
  });

  it("normalizes clone URLs", () => {
    expect(normalizeRepositoryUrl("git@github.com:example/repo.git")).toBe(
      "https://github.com/example/repo.git",
    );
  });
});
