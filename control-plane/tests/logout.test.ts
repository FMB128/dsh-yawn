import { describe, expect, it } from "vitest";

import { logoutPath } from "../src/client/logout-route.js";

describe("logout action", () => {
  it("uses the route the sign-in row advertises", () => {
    expect(logoutPath({ __DSH_YAWN_AUTH__: { logoutPath: "/logout" } })).toBe(
      "/logout",
    );
  });

  it("renders nothing without a mounted sign-in row", () => {
    expect(logoutPath({})).toBeUndefined();
    expect(logoutPath({ __DSH_YAWN_AUTH__: {} })).toBeUndefined();
    expect(
      logoutPath({ __DSH_YAWN_AUTH__: { logoutPath: "" } }),
    ).toBeUndefined();
  });
});
