/**
 * Which Git host a `_TOKEN` secret supplies a credential for. Shared by the
 * host (the broker serves the credential) and the Secrets page (which explains
 * the name while it is typed), so both agree on the spelling without the
 * settings wire carrying a derived field.
 */
const HOST_TOKEN_SECRET = /^([A-Z0-9]+(?:_[A-Z0-9]+)+)_TOKEN$/i;

/**
 * The hostname a host-shaped secret name spells: `GIT_EXAMPLE_COM_TOKEN` is
 * git.example.com, `GITLAB_COM_TOKEN` is gitlab.com. An environment name cannot
 * hold a dot, so `_` separates the labels. A name with no separator
 * (`GITHUB_TOKEN`, `NPM_TOKEN`) spells no host and stays a plain secret, and a
 * hyphenated hostname has no spelling here at all.
 */
export function hostFromTokenSecretName(name: string): string | undefined {
  const labels = HOST_TOKEN_SECRET.exec(name)?.[1];
  return labels?.toLowerCase().replaceAll("_", ".");
}
