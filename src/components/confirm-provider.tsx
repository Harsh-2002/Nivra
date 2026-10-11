"use client";
import { createContext, useContext, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "./ui/alert-dialog";
type Request = { title: string; description: string; action?: string };
type Confirm = (request: Request) => Promise<boolean>;
const Context = createContext<Confirm | null>(null);
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);
  const sequence = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const confirm: Confirm = (request) =>
    new Promise((resolve) => {
      resolver.current?.(false);
      resolver.current = resolve;
      returnFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      const ticket = ++sequence.current;
      const menu = document.querySelector(
        '[data-slot="dropdown-menu-content"]',
      );
      if (menu) {
        requestAnimationFrame(() => {
          void Promise.allSettled(
            menu.getAnimations().map((animation) => animation.finished),
          ).then(() => {
            requestAnimationFrame(() => {
              if (ticket === sequence.current) setRequest(request);
            });
          });
        });
      } else setRequest(request);
    });
  function settle(value: boolean) {
    sequence.current++;
    resolver.current?.(value);
    resolver.current = null;
    setRequest(null);
  }
  return (
    <Context.Provider value={confirm}>
      {children}
      <AlertDialog
        open={!!request}
        onOpenChange={(open) => {
          if (!open) settle(false);
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            const previous = returnFocus.current;
            const target = previous?.isConnected
              ? previous
              : previous?.getAttribute("aria-label") === "Open navigation"
                ? document.querySelector<HTMLElement>(
                    '.workspace button[aria-label="Open navigation"]',
                  )
                : null;
            if (target?.isConnected && target !== document.body) {
              event.preventDefault();
              target.focus({ preventScroll: true });
            }
          }}
        >
          <AlertDialogTitle>{request?.title}</AlertDialogTitle>
          <AlertDialogDescription>
            {request?.description}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => settle(false)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => settle(true)}>
              {request?.action || "Continue"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Context.Provider>
  );
}
export function useConfirm() {
  const confirm = useContext(Context);
  if (!confirm) throw new Error("Confirmation requires ConfirmProvider.");
  return confirm;
}
