import { useEffect, useState, type CSSProperties, type FormEvent } from "react";

import {
  Button,
  Input,
  Modal,
  Tag,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { SettingsSectionOwnerProps } from "@deepseek-ai/dsh-client-ui-settings/client";

import type { SecretSettingsView } from "../secrets-remote.js";
import { hostFromTokenSecretName } from "../secret-hosts.js";
import { GLOBAL_SCOPE, ScopeSelector } from "./scope-selector.js";
import {
  addButtonStyle,
  cardStyle,
  dialogFormStyle,
  errorStyle,
  fieldLabelStyle,
  firstFieldLabelStyle,
  groupHeadStyle,
  groupStyle,
  hintStyle,
  introStyle,
  listStyle,
  monoStyle,
  mutedStyle,
  sectionStyle,
  titleStyle,
} from "./settings-page-style.js";

interface SecretsActions {
  getSecrets: () => Promise<SecretSettingsView>;
  setGlobalSecret: (name: string, value: string) => Promise<SecretSettingsView>;
  setWorkspaceSecret: (
    repositoryUrl: string,
    name: string,
    value: string,
  ) => Promise<SecretSettingsView>;
  deleteGlobalSecret: (name: string) => Promise<SecretSettingsView>;
  deleteWorkspaceSecret: (
    repositoryUrl: string,
    name: string,
  ) => Promise<SecretSettingsView>;
}

interface SecretsSettingsProps
  extends SettingsSectionOwnerProps,
    SecretsActions {}

/** One secret, addressed by its scope: GLOBAL_SCOPE or a repository URL. */
interface SecretRef {
  scope: string;
  name: string;
}

/** The open dialog: a new secret, or a new value for an existing one. */
type Dialog = { kind: "add" } | ({ kind: "replace" } & SecretRef);

/**
 * Settings page for the host credential broker: every scope's secret names at
 * once, grouped like the stock Agent presets page, with adding and replacing
 * in a dialog. Values are write-only: saving one stores it, and nothing reads
 * it back.
 */
export function SecretsSettings({
  getSecrets,
  setGlobalSecret,
  setWorkspaceSecret,
  deleteGlobalSecret,
  deleteWorkspaceSecret,
}: SecretsSettingsProps) {
  const [settings, setSettings] = useState<SecretSettingsView>();
  const [dialog, setDialog] = useState<Dialog>();
  const [confirming, setConfirming] = useState<SecretRef>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    getSecrets().then(setSettings, (reason) => setError(describe(reason)));
  }, [getSecrets]);

  /** Run one write; the caller decides where a failure shows. */
  const run = async (action: () => Promise<SecretSettingsView>) => {
    setPending(true);
    try {
      setSettings(await action());
    } finally {
      setPending(false);
    }
  };

  const save = (scope: string, name: string, value: string) =>
    run(() =>
      scope === GLOBAL_SCOPE
        ? setGlobalSecret(name, value)
        : setWorkspaceSecret(scope, name, value),
    );

  const remove = async ({ scope, name }: SecretRef) => {
    setError(undefined);
    try {
      await run(() =>
        scope === GLOBAL_SCOPE
          ? deleteGlobalSecret(name)
          : deleteWorkspaceSecret(scope, name),
      );
      setConfirming(undefined);
    } catch (reason) {
      setError(describe(reason));
    }
  };

  const globalNames = settings?.global ?? [];
  const workspaces = (settings?.workspaces ?? []).filter(
    (workspace) => workspace.names.length > 0,
  );

  // A row draws its own top divider; the global card has no header above
  // its first row, so that one goes without.
  const rows = (scope: string, names: string[], divideFirst: boolean) =>
    names.map((name, index) => (
      <SecretRow
        key={name}
        name={name}
        divider={divideFirst || index > 0}
        overridesGlobal={scope !== GLOBAL_SCOPE && globalNames.includes(name)}
        confirming={confirming?.scope === scope && confirming.name === name}
        disabled={pending}
        onReplace={() => {
          setConfirming(undefined);
          setDialog({ kind: "replace", scope, name });
        }}
        onDelete={() => setConfirming({ scope, name })}
        onCancelDelete={() => setConfirming(undefined)}
        onConfirmDelete={() => void remove({ scope, name })}
      />
    ));

  return (
    <section style={sectionStyle}>
      <h2 style={titleStyle}>Secrets</h2>
      <p style={introStyle}>
        Environment variables for sandbox commands. Values are write-only.
      </p>

      {settings === undefined && error === undefined ? (
        <p style={introStyle}>Loading…</p>
      ) : null}

      {settings !== undefined ? (
        <>
          <div style={groupStyle}>
            <h3 style={groupHeadStyle}>Global</h3>
            <ul style={{ ...cardStyle, ...listStyle }}>
              {globalNames.length === 0 ? (
                <li style={{ ...rowStyle, ...mutedStyle, borderTop: "none" }}>
                  No global secrets yet.
                </li>
              ) : (
                rows(GLOBAL_SCOPE, globalNames, false)
              )}
            </ul>
          </div>

          {workspaces.length > 0 ? (
            <div style={{ ...groupStyle, marginTop: 20 }}>
              <h3 style={groupHeadStyle}>Workspaces</h3>
              {workspaces.map((workspace) => (
                <div key={workspace.repositoryUrl} style={cardStyle}>
                  <div style={cardHeadStyle}>
                    <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
                      {workspace.title}
                    </h4>
                    <span style={{ ...monoStyle, ...mutedStyle, fontSize: 11 }}>
                      {workspace.repositoryUrl}
                    </span>
                  </div>
                  <ul style={listStyle}>
                    {rows(workspace.repositoryUrl, workspace.names, true)}
                  </ul>
                </div>
              ))}
            </div>
          ) : null}

          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setConfirming(undefined);
              setDialog({ kind: "add" });
            }}
            style={{ ...addButtonStyle, opacity: pending ? 0.4 : 1 }}
          >
            <span aria-hidden="true">+</span> Add secret
          </button>

          <SecretDialog
            dialog={dialog}
            settings={settings}
            pending={pending}
            onSave={save}
            onClose={() => setDialog(undefined)}
          />
        </>
      ) : null}

      {error !== undefined ? (
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      ) : null}
    </section>
  );
}

interface SecretRowProps {
  name: string;
  divider: boolean;
  overridesGlobal: boolean;
  confirming: boolean;
  disabled: boolean;
  onReplace: () => void;
  onDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}

/** One secret name with its actions; Delete asks once before it removes. */
function SecretRow({
  name,
  divider,
  overridesGlobal,
  confirming,
  disabled,
  onReplace,
  onDelete,
  onCancelDelete,
  onConfirmDelete,
}: SecretRowProps) {
  return (
    <li style={divider ? rowStyle : { ...rowStyle, borderTop: "none" }}>
      <span
        style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}
      >
        <code style={nameStyle}>{name}</code>
        {overridesGlobal ? <Tag tone="outline">overrides global</Tag> : null}
      </span>
      <span
        style={{ display: "flex", alignItems: "center", gap: 4, flex: "none" }}
      >
        {confirming ? (
          <>
            <span style={{ ...mutedStyle, marginRight: 4 }}>Delete?</span>
            <Button
              type="button"
              size="sm"
              disabled={disabled}
              onClick={onCancelDelete}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="primary"
              disabled={disabled}
              onClick={onConfirmDelete}
              aria-label={`Confirm delete ${name}`}
            >
              Delete
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              size="sm"
              disabled={disabled}
              onClick={onReplace}
              aria-label={`Replace ${name}`}
            >
              Replace
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={disabled}
              onClick={onDelete}
              aria-label={`Delete ${name}`}
            >
              Delete
            </Button>
          </>
        )}
      </span>
    </li>
  );
}

interface SecretDialogProps {
  dialog: Dialog | undefined;
  settings: SecretSettingsView;
  pending: boolean;
  onSave: (scope: string, name: string, value: string) => Promise<void>;
  onClose: () => void;
}

/**
 * Add a secret, or replace the value of one. Replacing fixes the name and
 * scope, because a value cannot be read back to move it.
 */
function SecretDialog({
  dialog,
  settings,
  pending,
  onSave,
  onClose,
}: SecretDialogProps) {
  const [scope, setScope] = useState(GLOBAL_SCOPE);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => {
    setScope(dialog?.kind === "replace" ? dialog.scope : GLOBAL_SCOPE);
    setName(dialog?.kind === "replace" ? dialog.name : "");
    setValue("");
    setError(undefined);
  }, [dialog]);

  const replacing = dialog?.kind === "replace";
  const trimmed = name.trim();
  const namesIn = (target: string) =>
    target === GLOBAL_SCOPE
      ? settings.global
      : (settings.workspaces.find(
          (workspace) => workspace.repositoryUrl === target,
        )?.names ?? []);
  const scopeTitle =
    settings.workspaces.find((workspace) => workspace.repositoryUrl === scope)
      ?.title ?? scope;

  const replaceNote = `${
    scope === GLOBAL_SCOPE ? "Global secret" : `Secret for ${scopeTitle}`
  }. The new value replaces the saved one.`;

  // Hints help pick a name and scope, so only adding shows them.
  const hints: string[] = [];
  if (!replacing) {
    if (namesIn(scope).includes(trimmed)) {
      hints.push("Already set here; saving replaces its value.");
    } else if (scope !== GLOBAL_SCOPE && settings.global.includes(trimmed)) {
      hints.push("Overrides the global value in this workspace.");
    }
    if (trimmed === "GITHUB_TOKEN") {
      hints.push("Also used as the Git credential for github.com.");
    } else {
      const host = hostFromTokenSecretName(trimmed);
      if (host !== undefined) {
        hints.push(`Also used as the Git credential for ${host}.`);
      }
    }
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || trimmed === "" || value === "") {
      return;
    }
    setError(undefined);
    try {
      await onSave(scope, trimmed, value);
      onClose();
    } catch (reason) {
      setError(describe(reason));
    }
  };

  return (
    <Modal
      open={dialog !== undefined}
      onClose={() => {
        if (!pending) {
          onClose();
        }
      }}
      title={replacing ? `Replace ${dialog.name}` : "Add secret"}
      {...(replacing ? { description: replaceNote } : {})}
      closeLabel="Close"
      footer={
        <>
          <Button type="button" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="dsh-yawn-secret-form"
            variant="primary"
            disabled={pending || trimmed === "" || value === ""}
          >
            {pending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <form id="dsh-yawn-secret-form" onSubmit={submit} style={dialogFormStyle}>
        {replacing ? null : (
          <>
            <label htmlFor="dsh-yawn-secret-name" style={firstFieldLabelStyle}>
              Name
            </label>
            <Input
              id="dsh-yawn-secret-name"
              data-modal-autofocus
              placeholder="GITHUB_TOKEN"
              autoComplete="off"
              spellCheck={false}
              value={name}
              disabled={pending}
              onChange={(event) => setName(event.currentTarget.value)}
              style={{ width: "100%" }}
            />
          </>
        )}
        <label
          htmlFor="dsh-yawn-secret-value"
          style={replacing ? firstFieldLabelStyle : fieldLabelStyle}
        >
          Value
        </label>
        <Input
          id="dsh-yawn-secret-value"
          {...(replacing ? { "data-modal-autofocus": true } : {})}
          type="password"
          autoComplete="off"
          value={value}
          disabled={pending}
          onChange={(event) => setValue(event.currentTarget.value)}
          style={{ width: "100%" }}
        />
        {replacing ? null : (
          <>
            <label htmlFor="dsh-yawn-secret-scope" style={fieldLabelStyle}>
              Scope
            </label>
            <ScopeSelector
              id="dsh-yawn-secret-scope"
              workspaces={settings.workspaces}
              scope={scope}
              disabled={pending}
              onScopeChange={setScope}
              style={selectStyle}
            />
          </>
        )}
        {hints.length > 0 ? <p style={hintStyle}>{hints.join(" ")}</p> : null}
        {error !== undefined ? (
          <p role="alert" style={{ ...errorStyle, margin: "8px 0 0" }}>
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

const cardHeadStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 12,
  padding: "12px 16px",
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  minHeight: 44,
  boxSizing: "border-box",
  padding: "6px 10px 6px 16px",
  borderTop: "0.5px solid var(--dsw-alias-border-l2)",
};

const nameStyle: CSSProperties = { ...monoStyle, fontSize: 13 };

/** The native select drawn like the Input primitive beside it. */
const selectStyle: CSSProperties = {
  height: 32,
  minHeight: 0,
  padding: "0 8px",
  border: "0.5px solid var(--dsw-alias-border-l4)",
  borderRadius: "var(--dsw-radius-md)",
  fontSize: 14,
};
