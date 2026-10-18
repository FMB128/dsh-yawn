import type { CSSProperties } from "react";

// The list-and-dialog settings pages (Secrets, MCP) take their sizes and
// tokens from the stock Agent presets page, so they read as one surface.

export const sectionStyle: CSSProperties = {
  maxWidth: 720,
  display: "flex",
  flexDirection: "column",
  gap: 12,
  color: "var(--dsw-alias-label-primary)",
};

export const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 18,
  fontWeight: 600,
};

export const introStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: "var(--dsw-alias-label-tertiary)",
};

export const groupStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

export const groupHeadStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--dsw-alias-label-tertiary)",
};

export const listStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
};

export const cardStyle: CSSProperties = {
  border: "0.5px solid var(--dsw-alias-settings-card-stroke)",
  borderRadius: "var(--dsw-radius-xl)",
  background: "var(--dsw-alias-settings-card-fill)",
  overflow: "hidden",
};

export const monoStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontFamily: "var(--dsw-font-mono, ui-monospace, monospace)",
};

export const mutedStyle: CSSProperties = {
  fontSize: 13,
  color: "var(--dsw-alias-label-tertiary)",
};

/** A settings list row: name and tags on the left, actions on the right. */
export const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  minHeight: 44,
  boxSizing: "border-box",
  padding: "6px 10px 6px 16px",
  borderTop: "0.5px solid var(--dsw-alias-border-l2)",
};

/** The first row in a card, which has no divider above it. */
export const firstRowStyle: CSSProperties = { ...rowStyle, borderTop: "none" };

export const identityStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 8,
  minWidth: 0,
};

export const actionsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  flex: "none",
};

/** A code-like value inside a settings row. */
export const codeStyle: CSSProperties = { ...monoStyle, fontSize: 13 };

/** The dashed full-width "+ Add …" button under a list. */
export const addButtonStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  height: 44,
  marginTop: 8,
  boxSizing: "border-box",
  border: "1px dashed var(--dsw-alias-border-l3)",
  borderRadius: "var(--dsw-radius-lg)",
  background: "none",
  font: "inherit",
  fontSize: 14,
  color: "var(--dsw-alias-label-primary)",
  cursor: "pointer",
};

/** A dialog form: a column, so the Input primitive's wrapper stretches. */
export const dialogFormStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
};

export const fieldLabelStyle: CSSProperties = {
  margin: "14px 0 6px",
  fontSize: 13,
  fontWeight: 500,
};

export const firstFieldLabelStyle: CSSProperties = {
  ...fieldLabelStyle,
  marginTop: 0,
};

export const hintStyle: CSSProperties = {
  ...mutedStyle,
  margin: "8px 0 0",
  lineHeight: 1.5,
};

export const errorStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: "var(--dsw-alias-state-error-primary)",
};
