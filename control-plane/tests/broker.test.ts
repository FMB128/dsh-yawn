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

  it("serves a configured host from the secret it names", async () => {
    const broker = new CredentialBroker({
      path: join(directory, "broker.json"),
    });
    await broker.initialize();
    await broker.setSecret(GLOBAL_SECRET_SCOPE, "FORGE_TOKEN", "forge-pat");
    await broker.setSecret(GLOBAL_SECRET_SCOPE, "GITLAB_TOKEN", "gitlab-pat");
    await broker.setGitHost("git.fml128.ch", "oauth2", "FORGE_TOKEN");
    await broker.setGitHost("gitlab.com", "oauth2", "GITLAB_TOKEN");
    await broker.setGitHost(
      "git.example.com:8443",
      "x-token-auth",
      "FORGE_TOKEN",
    );

    expect(
      await broker.gitCredentials("https://git.fml128.ch/FML128/repo"),
    ).toEqual([
      { host: "git.fml128.ch", username: "oauth2", password: "forge-pat" },
      { host: "gitlab.com", username: "oauth2", password: "gitlab-pat" },
      {
        host: "git.example.com:8443",
        username: "x-token-auth",
        password: "forge-pat",
      },
    ]);
  });

  it("skips a configured host until its secret exists", async () => {
    const broker = new CredentialBroker({
      path: join(directory, "broker.json"),
    });
    await broker.initialize();
    await broker.setGitHost("git.fml128.ch", "oauth2", "FORGE_TOKEN");

    expect(
      await broker.gitCredentials("https://git.fml128.ch/FML128/repo"),
    ).toEqual([]);

    await broker.setSecret(GLOBAL_SECRET_SCOPE, "FORGE_TOKEN", "forge-pat");
    expect(
      await broker.gitCredentials("https://git.fml128.ch/FML128/repo"),
    ).toEqual([
      { host: "git.fml128.ch", username: "oauth2", password: "forge-pat" },
    ]);
  });

  it("uses the workspace value of the named secret", async () => {
    const broker = new CredentialBroker({
      path: join(directory, "broker.json"),
    });
    await broker.initialize();
    await broker.setSecret(GLOBAL_SECRET_SCOPE, "FORGE_TOKEN", "global");
    await broker.setSecret(
      workspace("https://git.fml128.ch/FML128/repo"),
      "FORGE_TOKEN",
      "workspace",
    );
    await broker.setGitHost("git.fml128.ch", "oauth2", "FORGE_TOKEN");

    expect(
      await broker.gitCredentials("https://git.fml128.ch/FML128/repo"),
    ).toEqual([
      { host: "git.fml128.ch", username: "oauth2", password: "workspace" },
    ]);
    expect(
      await broker.gitCredentials("https://git.fml128.ch/other/repo"),
    ).toEqual([
      { host: "git.fml128.ch", username: "oauth2", password: "global" },
    ]);
  });

  it("lets an explicit github.com row replace the built-in entry", async () => {
    const broker = new CredentialBroker({
      path: join(directory, "broker.json"),
    });
    await broker.initialize();
    await broker.setSecret(GLOBAL_SECRET_SCOPE, "GITHUB_TOKEN", "built-in");
    await broker.setSecret(GLOBAL_SECRET_SCOPE, "GH_PAT", "explicit");
    await broker.setGitHost("github.com", "oauth2", "GH_PAT");

    expect(
      await broker.gitCredentials("https://github.com/example/repo"),
    ).toEqual([
      { host: "github.com", username: "oauth2", password: "explicit" },
    ]);
  });

  it("does not fall back when a github.com row has no secret", async () => {
    const broker = new CredentialBroker({
      path: join(directory, "broker.json"),
    });
    await broker.initialize();
    await broker.setSecret(GLOBAL_SECRET_SCOPE, "GITHUB_TOKEN", "built-in");
    await broker.setGitHost("github.com", "oauth2", "MISSING");

    expect(
      await broker.gitCredentials("https://github.com/example/repo"),
    ).toEqual([]);
  });

  it("stores the Git host table across a reload and deletes a row", async () => {
    const broker = new CredentialBroker({
      path: join(directory, "broker.json"),
    });
    await broker.initialize();
    await broker.setGitHost("Git.FML128.CH", "oauth2", "FORGE_TOKEN");
    expect(broker.gitHosts()).toEqual([
      { host: "git.fml128.ch", username: "oauth2", secret: "FORGE_TOKEN" },
    ]);

    await broker.setGitHost("git.fml128.ch", "x-token-auth", "OTHER_TOKEN");
    expect(broker.gitHosts()).toEqual([
      {
        host: "git.fml128.ch",
        username: "x-token-auth",
        secret: "OTHER_TOKEN",
      },
    ]);

    const reloaded = new CredentialBroker({
      path: join(directory, "broker.json"),
    });
    await reloaded.initialize();
    expect(reloaded.gitHosts()).toEqual(broker.gitHosts());

    await reloaded.deleteGitHost("GIT.FML128.CH");
    expect(reloaded.gitHosts()).toEqual([]);
  });

  it("rejects an invalid Git host row", async () => {
    const broker = new CredentialBroker({
      path: join(directory, "broker.json"),
    });
    await broker.initialize();

    await expect(
      broker.setGitHost("https://git.example.com", "oauth2", "TOKEN"),
    ).rejects.toThrow("host name");
    await expect(
      broker.setGitHost("git.example.com", "bad\nuser", "TOKEN"),
    ).rejects.toThrow("username");
    await expect(
      broker.setGitHost("git.example.com", "oauth2", "not-valid"),
    ).rejects.toThrow("secret name");
  });

  it("reads a version 1 file as global-only and writes version 3", async () => {
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
    expect(broker.gitHosts()).toEqual([]);
    await broker.setSecret(GLOBAL_SECRET_SCOPE, "NEW", "value");
    const saved = JSON.parse(await readFile(path, "utf8")) as {
      version: number;
      workspaces: Record<string, unknown>;
      gitHosts: unknown[];
    };
    expect(saved.version).toBe(3);
    expect(saved.workspaces).toEqual({});
    expect(saved.gitHosts).toEqual([]);
  });

  it("reads a version 2 file as having no Git hosts", async () => {
    const path = join(directory, "broker.json");
    await writeFile(
      path,
      `${JSON.stringify({
        version: 2,
        secrets: { LEGACY: "kept" },
        workspaces: {
          "https://github.com/a/x": { API_KEY: "workspace" },
        },
      })}\n`,
      "utf8",
    );
    const broker = new CredentialBroker({ path });
    await broker.initialize();

    expect(broker.secretNames(GLOBAL_SECRET_SCOPE)).toEqual(["LEGACY"]);
    expect(broker.secrets(workspace("https://github.com/a/x"))).toEqual({
      LEGACY: "kept",
      API_KEY: "workspace",
    });
    expect(broker.secretNames(workspace("https://github.com/a/x"))).toEqual([
      "API_KEY",
    ]);
    expect(broker.gitHosts()).toEqual([]);
  });

  it("normalizes and deduplicates Git host rows on load", async () => {
    const path = join(directory, "broker.json");
    await writeFile(
      path,
      `${JSON.stringify({
        version: 3,
        secrets: {},
        workspaces: {},
        gitHosts: [
          { host: "Git.Example.COM", username: " oauth2 ", secret: " TOKEN " },
          {
            host: "git.example.com",
            username: "x-token-auth",
            secret: "OTHER",
          },
        ],
      })}\n`,
      "utf8",
    );
    const broker = new CredentialBroker({ path });
    await broker.initialize();

    expect(broker.gitHosts()).toEqual([
      { host: "git.example.com", username: "x-token-auth", secret: "OTHER" },
    ]);
    // The stored host is canonical, so the normalized input deletes it.
    await broker.deleteGitHost("GIT.EXAMPLE.COM");
    expect(broker.gitHosts()).toEqual([]);
  });

  it("rejects a v3 file with an invalid Git host row", async () => {
    const path = join(directory, "broker.json");
    await writeFile(
      path,
      `${JSON.stringify({
        version: 3,
        secrets: {},
        workspaces: {},
        gitHosts: [
          {
            host: "https://git.example.com",
            username: "oauth2",
            secret: "TOKEN",
          },
        ],
      })}\n`,
      "utf8",
    );
    const broker = new CredentialBroker({ path });

    await expect(broker.initialize()).rejects.toThrow("unsupported format");
  });

  it("normalizes clone URLs", () => {
    expect(normalizeRepositoryUrl("git@github.com:example/repo.git")).toBe(
      "https://github.com/example/repo.git",
    );
  });
});
