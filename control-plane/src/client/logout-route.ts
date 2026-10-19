/** What a mounted sign-in row advertises to the web client. */
export interface AuthUi {
  logoutPath?: string;
}

declare global {
  interface Window {
    __DSH_YAWN_AUTH__?: AuthUi;
  }
}

/**
 * The logout route the host advertised. A checkout profile mounts no sign-in
 * row, so the global is absent and the sidebar shows no action.
 */
export function logoutPath(page: {
  __DSH_YAWN_AUTH__?: AuthUi;
}): string | undefined {
  const path = page.__DSH_YAWN_AUTH__?.logoutPath;
  return path === undefined || path === "" ? undefined : path;
}
