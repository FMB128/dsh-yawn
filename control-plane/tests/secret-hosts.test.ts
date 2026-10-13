import { describe, expect, it } from "vitest";

import { hostFromTokenSecretName } from "../src/secret-hosts.js";

describe("host-shaped token secret names", () => {
  it("spells a hostname with underscores between its labels", () => {
    expect(hostFromTokenSecretName("GIT_EXAMPLE_COM_TOKEN")).toBe(
      "git.example.com",
    );
    expect(hostFromTokenSecretName("GITLAB_COM_TOKEN")).toBe("gitlab.com");
    // The store allows lowercase environment names too.
    expect(hostFromTokenSecretName("codeberg_org_token")).toBe("codeberg.org");
  });

  it("leaves names that do not spell a multi-label host alone", () => {
    // One label: `GITHUB_TOKEN` is handled as the github.com credential itself.
    expect(hostFromTokenSecretName("GITHUB_TOKEN")).toBeUndefined();
    expect(hostFromTokenSecretName("NPM_TOKEN")).toBeUndefined();
    // No host at all, or a spelling an environment name cannot carry.
    expect(hostFromTokenSecretName("TOKEN")).toBeUndefined();
    expect(hostFromTokenSecretName("_TOKEN")).toBeUndefined();
    expect(hostFromTokenSecretName("GIT_EXAMPLE_COM")).toBeUndefined();
    expect(hostFromTokenSecretName("GIT-EXAMPLE-COM-TOKEN")).toBeUndefined();
    expect(hostFromTokenSecretName("GIT_EXAMPLE__COM_TOKEN")).toBeUndefined();
    expect(
      hostFromTokenSecretName("GIT_EXAMPLE_COM_TOKEN_EXTRA"),
    ).toBeUndefined();
  });
});
