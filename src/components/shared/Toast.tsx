import {
  createContext, useCallback, useContext, useRef, useState,
  type ReactNode,
} from "react";
import { useContextActions } from "../../store/context";

interface ToastOptions {
  message: string;
  /** 给了才渲染撤销按钮；点击 = actions.back()，回退到跳转前的完整状态 */
  undoLabel?: string;
}

interface ToastState extends ToastOptions {
  id: number;
}

interface ToastApi {
  show(opts: ToastOptions): void;
}

const AUTO_DISMISS_MS = 4000;

const ToastCtx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const actions = useContextActions();
  const [toast, setToast] = useState<ToastState | null>(null);
  const timerRef = useRef<number | null>(null);
  const idRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const dismiss = useCallback(() => {
    clearTimer();
    setToast(null);
  }, [clearTimer]);

  const arm = useCallback(() => {
    clearTimer();
    timerRef.current = window.setTimeout(dismiss, AUTO_DISMISS_MS);
  }, [clearTimer, dismiss]);

  const show = useCallback(
    (opts: ToastOptions) => {
      idRef.current += 1;
      setToast({ ...opts, id: idRef.current });
      arm();
    },
    [arm]
  );

  function handleUndo() {
    dismiss();
    actions.back();
  }

  return (
    <ToastCtx.Provider value={{ show }}>
      {children}
      {toast && (
        <div
          className="toast"
          role="status"
          onMouseEnter={clearTimer}
          onMouseLeave={arm}
        >
          <span className="toast__message">{toast.message}</span>
          {toast.undoLabel && (
            <button type="button" className="toast__undo" onClick={handleUndo}>
              {toast.undoLabel}
            </button>
          )}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

export function useToast(): ToastApi {
  const v = useContext(ToastCtx);
  if (!v) throw new Error("useToast 必须在 ToastProvider 内使用");
  return v;
}
