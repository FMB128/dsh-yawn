import { useEffect, useState, type FormEvent } from "react";

import {
  Button,
  Input,
  Modal,
  Tag,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { SettingsSectionOwnerProps } from "@deepseek-ai/dsh-client-ui-settings/client";

import {
  DEFAULT_GIT_USERNAME,
  GITHUB_HOST,
  GITHUB_SECRET,
  GITHUB_USERNAME,
  hasGithubCredentialRow,
  type GitHostCredential,
} from "../git-hosts.js";
import type { SecretSettingsView } from "../secrets-remote.js";
import {
  actionsStyle,
  addButtonStyle,
  cardStyle,
  codeStyle,
  dialogFormStyle,
  errorStyle,
  fieldLabelStyle,
  firstFieldLabelStyle,
  firstRowStyle,
  groupHeadStyle,
  groupStyle,
  hintStyle,
  identityStyle,
  introStyle,
  listStyle,
  mutedStyle,
  rowStyle,
  sectionStyle,
  titleStyle,
} from "./settings-page-style.js";

interface GitCredentialActions {
  getSecrets: () => Promise<SecretSettingsView>;
  setGitHost: (
    host: string,
    username: string,
    secret: string,
  ) => Promise<SecretSettingsView>;
  deleteGitHost: (host: string) => Promise<SecretSettingsView>;
}

interface GitCredentialsSettingsProps
  extends SettingsSectionOwnerProps,
    GitCredentialActions {}

type Dialog = { kind: "add" } | { kind: "edit"; entry: GitHostCredential };

/**
 * Settings page for the explicit Git credential table: which secret answers
 * for a host and which username Git sends. The built-in github.com entry is
 * shown read-only; a table row for github.com replaces it.
 */
export function GitCredentialsSettings({
  getSecrets,
  setGitHost,
  deleteGitHost,
}: GitCredentialsSettingsProps) {
  const [settings, setSettings] = useState<SecretSettingsView>();
  const [dialog, setDialog] = useState<Dialog>();
  const [confirming, setConfirming] = useState<string>();
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

  const remove = async (host: string) => {
    setError(undefined);
    try {
      await run(() => deleteGitHost(host));
      setConfirming(undefined);
    } catch (reason) {
      setError(describe(reason));
    }
  };

  const names = settings === undefined ? [] : allSecretNames(settings);
  const configured = new Set(names);
  const rows = settings?.gitHosts ?? [];
  const hasGithubRow = hasGithubCredentialRow(rows);

  return (
    <section style={sectionStyle}>
      <h2 style={titleStyle}>Git credentials</h2>
      <p style={introStyle}>
        New Workspaces clone over HTTPS. Add the token for a private host here;
        the password comes from the named secret, so a workspace that overrides
        the secret clones with its own value.
      </p>

      {settings === undefined && error === undefined ? (
        <p style={introStyle}>Loading…</p>
      ) : null}

      {settings !== undefined ? (
        <>
          <div style={groupStyle}>
            <h3 style={groupHeadStyle}>Hosts</h3>
            <ul style={{ ...cardStyle, ...listStyle }}>
              {hasGithubRow ? null : (
                <li style={firstRowStyle}>
                  <span style={identityStyle}>
                    <code style={codeStyle}>{GITHUB_HOST}</code>
                    <span style={mutedStyle}>{GITHUB_USERNAME}</span>
                    <code style={codeStyle}>{GITHUB_SECRET}</code>
                    <Tag tone="outline">built in</Tag>
                    {configured.has(GITHUB_SECRET) ? null : (
                      <Tag tone="warning">not set</Tag>
                    )}
                  </span>
                </li>
              )}
              {rows.map((entry) => (
                <li
                  key={entry.host}
                  style={
                    hasGithubRow && entry === rows[0] ? firstRowStyle : rowStyle
                  }
                >
                  <span style={identityStyle}>
                    <code style={codeStyle}>{entry.host}</code>
                    <span style={mutedStyle}>{entry.username}</span>
                    <code style={codeStyle}>{entry.secret}</code>
                    {configured.has(entry.secret) ? null : (
                      <Tag tone="warning">not set</Tag>
                    )}
                  </span>
                  <span style={actionsStyle}>
                    {confirming === entry.host ? (
                      <>
                        <span style={{ ...mutedStyle, marginRight: 4 }}>
                          Remove?
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          disabled={pending}
                          onClick={() => setConfirming(undefined)}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="primary"
                          disabled={pending}
                          onClick={() => void remove(entry.host)}
                          aria-label={`Confirm remove ${entry.host}`}
                        >
                          Remove
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          disabled={pending}
                          onClick={() => {
                            setConfirming(undefined);
                            setDialog({ kind: "edit", entry });
                          }}
                          aria-label={`Edit ${entry.host}`}
                        >
                          Edit
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          disabled={pending}
                          onClick={() => setConfirming(entry.host)}
                          aria-label={`Remove ${entry.host}`}
                        >
                          Remove
                        </Button>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setConfirming(undefined);
              setDialog({ kind: "add" });
            }}
            style={{ ...addButtonStyle, opacity: pending ? 0.4 : 1 }}
          >
            <span aria-hidden="true">+</span> Add Git host
          </button>

          <GitHostDialog
            dialog={dialog}
            names={names}
            pending={pending}
            onSave={async (entry) => {
              await run(() =>
                setGitHost(entry.host, entry.username, entry.secret),
              );
            }}
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

interface GitHostDialogProps {
  dialog: Dialog | undefined;
  names: string[];
  pending: boolean;
  onSave: (entry: GitHostCredential) => Promise<void>;
  onClose: () => void;
}

/** Add a host, or edit one; the host is the key, so editing keeps it fixed. */
function GitHostDialog({
  dialog,
  names,
  pending,
  onSave,
  onClose,
}: GitHostDialogProps) {
  const [host, setHost] = useState("");
  const [username, setUsername] = useState(DEFAULT_GIT_USERNAME);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (dialog?.kind === "edit") {
      setHost(dialog.entry.host);
      setUsername(dialog.entry.username);
      setSecret(dialog.entry.secret);
    } else {
      setHost("");
      setUsername(DEFAULT_GIT_USERNAME);
      setSecret("");
    }
    setError(undefined);
  }, [dialog]);

  const editing = dialog?.kind === "edit";
  const trimmedHost = host.trim();
  const trimmedUsername = username.trim();
  const trimmedSecret = secret.trim();
  const missingSecret = trimmedSecret !== "" && !names.includes(trimmedSecret);
  const replacesBuiltIn = trimmedHost.toLowerCase() === GITHUB_HOST;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      pending ||
      trimmedHost === "" ||
      trimmedUsername === "" ||
      trimmedSecret === ""
    ) {
      return;
    }
    setError(undefined);
    try {
      await onSave({
        host: trimmedHost,
        username: trimmedUsername,
        secret: trimmedSecret,
      });
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
      title={editing ? `Edit ${dialog.entry.host}` : "Add Git host"}
      closeLabel="Close"
      footer={
        <>
          <Button type="button" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="dsh-yawn-git-host-form"
            variant="primary"
            disabled={
              pending ||
              trimmedHost === "" ||
              trimmedUsername === "" ||
              trimmedSecret === ""
            }
          >
            {pending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <form
        id="dsh-yawn-git-host-form"
        onSubmit={submit}
        style={dialogFormStyle}
      >
        <label htmlFor="dsh-yawn-git-host" style={firstFieldLabelStyle}>
          Host
        </label>
        <Input
          id="dsh-yawn-git-host"
          {...(editing ? {} : { "data-modal-autofocus": true })}
          placeholder="git.example.com"
          autoComplete="off"
          spellCheck={false}
          value={host}
          disabled={pending || editing}
          onChange={(event) => setHost(event.currentTarget.value)}
          style={{ width: "100%" }}
        />
        <label htmlFor="dsh-yawn-git-username" style={fieldLabelStyle}>
          Username
        </label>
        <Input
          id="dsh-yawn-git-username"
          placeholder={DEFAULT_GIT_USERNAME}
          autoComplete="off"
          spellCheck={false}
          value={username}
          disabled={pending}
          onChange={(event) => setUsername(event.currentTarget.value)}
          style={{ width: "100%" }}
        />
        <label htmlFor="dsh-yawn-git-secret" style={fieldLabelStyle}>
          Secret
        </label>
        <Input
          id="dsh-yawn-git-secret"
          {...(editing ? { "data-modal-autofocus": true } : {})}
          list="dsh-yawn-git-secret-names"
          placeholder="GITHUB_TOKEN"
          autoComplete="off"
          spellCheck={false}
          value={secret}
          disabled={pending}
          onChange={(event) => setSecret(event.currentTarget.value)}
          style={{ width: "100%" }}
        />
        <datalist id="dsh-yawn-git-secret-names">
          {names.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <p style={hintStyle}>
          Git sends the username and the secret&apos;s value. A workspace-scoped
          secret overrides the global one there.
        </p>
        {replacesBuiltIn ? (
          <p style={hintStyle}>
            This row replaces the built-in {GITHUB_SECRET} credential for{" "}
            {GITHUB_HOST}, even before the secret is set. Remove the row to use
            the built-in.
          </p>
        ) : null}
        {missingSecret ? (
          <p style={hintStyle}>
            No secret is named {trimmedSecret} yet. Add it on the Secrets page.
          </p>
        ) : null}
        {error !== undefined ? (
          <p role="alert" style={{ ...errorStyle, margin: "8px 0 0" }}>
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

function allSecretNames(settings: SecretSettingsView): string[] {
  return [
    ...new Set([
      ...settings.global,
      ...settings.workspaces.flatMap((workspace) => workspace.names),
    ]),
  ].sort();
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
