import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button, Input, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { DirectoryFlowOwnerProps } from "@deepseek-ai/dsh-client-ui-workspace/client";

export interface RepositoryDirectoryFlowProps extends DirectoryFlowOwnerProps {
  createWorkspaceAnchor: (repositoryUrl: string) => Promise<string>;
}

/** Repository URL dialog occupying dsh's two Workspace directory-flow slots. */
export function RepositoryDirectoryFlow({
  open,
  busy,
  onPicked,
  onCancel,
  createWorkspaceAnchor,
}: RepositoryDirectoryFlowProps) {
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current) {
      setRepositoryUrl("");
      setPending(false);
      setError(undefined);
    }
    wasOpen.current = open;
  }, [open]);

  const disabled = pending || busy;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled) {
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      onPicked(await createWorkspaceAnchor(repositoryUrl));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!disabled) {
          onCancel();
        }
      }}
      title="Add repository"
      description="Create an isolated workspace from a Git repository."
      closeLabel="Close"
      className="dsh-yawn-repository-dialog"
      footer={
        <>
          <Button type="button" onClick={onCancel} disabled={disabled}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="dsh-yawn-repository-form"
            variant="primary"
            disabled={disabled || repositoryUrl.trim().length === 0}
          >
            {disabled ? "Adding…" : "Add repository"}
          </Button>
        </>
      }
    >
      <form id="dsh-yawn-repository-form" onSubmit={submit}>
        <label
          htmlFor="dsh-yawn-repository-url"
          style={{ display: "block", marginBottom: 8, fontWeight: 500 }}
        >
          Repository URL
        </label>
        <Input
          id="dsh-yawn-repository-url"
          type="text"
          inputMode="url"
          autoComplete="url"
          autoFocus
          placeholder="https://github.com/owner/repository"
          value={repositoryUrl}
          disabled={disabled}
          onChange={(event) => setRepositoryUrl(event.currentTarget.value)}
          aria-describedby={
            error === undefined
              ? "dsh-yawn-repository-hint"
              : "dsh-yawn-repository-error"
          }
          style={{ width: "100%" }}
        />
        {error === undefined ? (
          <p
            id="dsh-yawn-repository-hint"
            style={{ margin: "8px 0 0", opacity: 0.7, fontSize: 13 }}
          >
            Workspaces clone over HTTPS. An SSH URL is converted; private
            repositories need a token for the host.
          </p>
        ) : (
          <p
            id="dsh-yawn-repository-error"
            role="alert"
            style={{ margin: "8px 0 0", color: "var(--dsw-color-error)" }}
          >
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
