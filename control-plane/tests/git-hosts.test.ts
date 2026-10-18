import { describe, expect, it } from "vitest";

import {
  gitHostsForSecret,
  hasGithubCredentialRow,
  isGitHostCredential,
  normalizeGitHost,
  normalizeGitSecretName,
  normalizeGitUsername,
} from "../src/git-hosts.js";

describe("Git host credential rules", () => {
  it("normalizes a host and keeps an optional port", () => {
    expect(normalizeGitHost(" Git.FML128.CH ")).toBe("git.fml128.ch");
    expect(normalizeGitHost("git.example.com:8443")).toBe(
      "git.example.com:8443",
    );
    expect(normalizeGitHost("git.example.com:08443")).toBe(
      "git.example.com:8443",
    );
    expect(normalizeGitHost("git.example.com:443")).toBe("git.example.com");
    expect(normalizeGitHost("my-git.example.com")).toBe("my-git.example.com");
    expect(normalizeGitHost("localhost")).toBe("localhost");
  });

  it("derives the hosts a secret supplies, including built-in github.com", () => {
    const rows = [
      { host: "git.fml128.ch", username: "oauth2", secret: "FORGE_TOKEN" },
      { host: "gitlab.com", username: "oauth2", secret: "FORGE_TOKEN" },
    ];
    expect(hasGithubCredentialRow(rows)).toBe(false);
    expect(gitHostsForSecret(rows, "FORGE_TOKEN")).toEqual([
      "git.fml128.ch",
      "gitlab.com",
    ]);
    expect(gitHostsForSecret(rows, "GITHUB_TOKEN")).toEqual(["github.com"]);

    const withGithub = [
      ...rows,
      { host: "github.com", username: "oauth2", secret: "GH_PAT" },
    ];
    expect(hasGithubCredentialRow(withGithub)).toBe(true);
    expect(gitHostsForSecret(withGithub, "GITHUB_TOKEN")).toEqual([]);
    expect(gitHostsForSecret(withGithub, "GH_PAT")).toEqual(["github.com"]);
  });

  it("rejects a scheme, path, or a bad port", () => {
    for (const host of [
      "",
      "https://git.example.com",
      "git.example.com/repo",
      "git.example.com:",
      "git.example.com:0",
      "git.example.com:70000",
      "git..example.com",
      "-git.example.com",
      "git.example.com.",
    ]) {
      expect(() => normalizeGitHost(host)).toThrow();
    }
  });

  it("keeps the username non-empty and on one line", () => {
    expect(normalizeGitUsername(" oauth2 ")).toBe("oauth2");
    expect(() => normalizeGitUsername(" ")).toThrow("username");
    expect(() => normalizeGitUsername("bad\nuser")).toThrow("username");
  });

  it("requires the secret to be an environment name", () => {
    expect(normalizeGitSecretName(" FORGE_TOKEN ")).toBe("FORGE_TOKEN");
    expect(normalizeGitSecretName("codeberg_org_token")).toBe(
      "codeberg_org_token",
    );
    expect(() => normalizeGitSecretName("not-valid")).toThrow("secret name");
    expect(() => normalizeGitSecretName("")).toThrow("secret name");
  });

  it("recognizes a stored row only when all three fields are strings", () => {
    expect(
      isGitHostCredential({
        host: "git.example.com",
        username: "oauth2",
        secret: "TOKEN",
      }),
    ).toBe(true);
    expect(
      isGitHostCredential({ host: "git.example.com", username: "oauth2" }),
    ).toBe(false);
    expect(
      isGitHostCredential({
        host: "git.example.com",
        username: 1,
        secret: "TOKEN",
      }),
    ).toBe(false);
    expect(isGitHostCredential(null)).toBe(false);
  });
});
