import { useEffect, useState } from "react";

import {
  IconEllipsisOutlineMedium,
  IconSettingsOutlineMedium,
  Menu,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { SettingsLauncherOwnerProps } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";

import { logoutPath } from "./logout-route.js";

/** CSS class that lets the menu wrapper take the Settings row's width. */
export const MORE_MENU_CLASS = "dsh-yawn-more-menu";

/** The wrapper rule `Menu` cannot express as an inline style. */
export const MORE_MENU_STYLE = `.${MORE_MENU_CLASS}{display:flex;flex:1;min-width:0}`;

type MoreMenuProps = PropsRuntime<"settings.launcher"> &
  SettingsLauncherOwnerProps;

/**
 * The sidebar foot used to hold dsh's account launcher: an ellipsis leading a
 * menu with Settings and Sign out. Account sign-in is disabled in this
 * distribution, so this occupies the same `settings.launcher` seat and keeps
 * that menu shape without the account rows.
 */
export function MoreMenu({
  wide,
  settingsOpen,
  settingsShortcut,
  openSettings,
}: MoreMenuProps) {
  const [open, setOpen] = useState(false);
  const path = logoutPath(window);

  // A shortcut or another surface can open Settings while the menu is showing.
  useEffect(() => {
    if (settingsOpen) {
      setOpen(false);
    }
  }, [settingsOpen]);

  if (path === undefined) {
    return null;
  }

  return (
    <Menu
      open={open}
      side="top"
      portal
      autoFocus
      className={MORE_MENU_CLASS}
      anchor={
        <button
          type="button"
          aria-label="More"
          title={wide ? undefined : "More"}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          style={{
            width: "100%",
            height: wide ? 42 : 36,
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            justifyContent: wide ? "flex-start" : "center",
            gap: 8,
            padding: wide ? "0 10px 0 8px" : 0,
            border: "none",
            borderRadius: "var(--dsw-radius-md)",
            background: open ? "var(--dsw-alias-interactive-bg-hover)" : "none",
            color: "var(--dsw-alias-label-primary)",
            cursor: "pointer",
            font: "inherit",
            fontSize: 14,
            lineHeight: "22px",
            textAlign: "left",
          }}
        >
          <IconEllipsisOutlineMedium size={16} />
          {wide && <span>More</span>}
        </button>
      }
      items={[
        {
          id: "settings",
          label: "Settings",
          icon: <IconSettingsOutlineMedium size={16} />,
          ...(settingsShortcut === undefined
            ? {}
            : { shortcut: settingsShortcut }),
        },
        {
          id: "signout",
          label: "Sign out",
          icon: <SignOutIcon />,
        },
      ]}
      onClose={() => setOpen(false)}
      onSelect={(id) => {
        if (id === "settings") {
          setOpen(false);
          openSettings();
        } else {
          window.location.assign(path);
        }
      }}
    />
  );
}

/** A door with an arrow leaving it, in the 16px outline style of the shell. */
function SignOutIcon() {
  return (
    <svg
      aria-hidden
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: "none" }}
    >
      <path d="M6.5 2.5h-3A1.5 1.5 0 0 0 2 4v8a1.5 1.5 0 0 0 1.5 1.5h3" />
      <path d="M5.5 8H14" />
      <path d="m11.5 5.5 2.5 2.5-2.5 2.5" />
    </svg>
  );
}
