import { classes } from "../styles/classes";
import { useI18n } from "../i18n/provider";
import { useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { errorText } from "../i18n/index";
export function Notice({ error }: { error: unknown }) {
  const { t } = useI18n();
  return error ? (
    <p role="alert" className={classes("error")}>
      {errorText(t, error)}
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
  const { t } = useI18n();
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
            {children ?? t("common.confirmDescription")}
          </Dialog.Description>
          <Notice error={error} />
          <div className={classes("actions")}>
            <Dialog.Close asChild>
              <button>{t("common.cancel")}</button>
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
              {t("common.confirm")}
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
