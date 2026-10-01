import { classes } from "../styles/classes";
import { ui } from "../i18n/es";
import { useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
export function Notice({ error }: { error: unknown }) {
  return error ? (
    <p role="alert" className={classes("error")}>
      {(error instanceof Error ? error.message : String(error)).replace(
        /https?:\/\/[^\s<>"']+/gi,
        "[recurso privado]",
      )}
    </p>
  ) : null;
}
export function Confirm({
  label,
  title,
  children,
  onConfirm,
}: {
  label: string;
  title: string;
  children?: ReactNode;
  onConfirm: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button">{label}</button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={classes("overlay")} />
        <Dialog.Content className={classes("dialog")}>
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description>
            {children ??
              "Confirma esta operación. No se puede deshacer desde esta pantalla."}
          </Dialog.Description>
          <Notice error={error} />
          <div className={classes("actions")}>
            <Dialog.Close asChild>
              <button>{ui.cancelar_bb9dbb}</button>
            </Dialog.Close>
            <button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onConfirm()
                  .then(() => setOpen(false))
                  .catch(setError)
                  .finally(() => setBusy(false));
              }}
            >
              {ui.confirmar_717bed}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className={classes("empty")}>{children}</div>;
}
