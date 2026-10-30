import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { Link, isRouteErrorResponse, useRouteError } from "react-router-dom";
import { Icon } from "./icons.js";

/* ---------- Button ---------- */

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  loading?: boolean;
}

export function Button({ variant = "secondary", loading = false, disabled, className, children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={`fp-btn fp-btn-${variant}${className ? ` ${className}` : ""}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <span className="fp-spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

/* ---------- Page header / breadcrumbs ---------- */

export interface Crumb {
  label: string;
  to?: string;
}

export function PageHeader({
  title,
  description,
  crumbs,
  actions,
}: {
  title: string;
  description?: ReactNode;
  crumbs?: Crumb[];
  actions?: ReactNode;
}) {
  return (
    <div className="fp-page-header">
      {crumbs && crumbs.length > 0 ? (
        <nav aria-label="Breadcrumb" className="fp-crumbs">
          <ol>
            {crumbs.map((c, i) => (
              <li key={`${c.label}-${i}`}>
                {c.to && i < crumbs.length - 1 ? (
                  <Link to={c.to}>{c.label}</Link>
                ) : (
                  <span aria-current={i === crumbs.length - 1 ? "page" : undefined}>{c.label}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
      <div className="fp-page-title-row">
        <div>
          <h1>{title}</h1>
          {description ? <p className="fp-page-desc">{description}</p> : null}
        </div>
        {actions ? <div className="fp-page-actions">{actions}</div> : null}
      </div>
    </div>
  );
}

/* ---------- Cards, KPI, states ---------- */

export function KpiCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  return (
    <div className={`fp-kpi fp-kpi-${tone}`}>
      <div className="fp-kpi-label">{label}</div>
      <div className="fp-kpi-value">{value}</div>
      {hint ? <div className="fp-kpi-hint">{hint}</div> : null}
    </div>
  );
}

export function Skeleton({ lines = 3, label = "Loading" }: { lines?: number; label?: string }) {
  return (
    <div className="fp-skeleton" role="status" aria-live="polite">
      <span className="fp-sr">{label}…</span>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="fp-skeleton-line" style={{ width: `${100 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="fp-empty">
      <Icon name="info" size={28} />
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function InlineAlert({ tone = "error", children }: { tone?: "error" | "success" | "warning" | "info"; children: ReactNode }) {
  return (
    <div className={`fp-alert fp-alert-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <Icon name={tone === "success" ? "check" : tone === "info" ? "info" : "alert"} />
      <div>{children}</div>
    </div>
  );
}

/* ---------- Confirmation dialog ---------- */

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Destructive / money-moving actions use the red button. */
  tone?: "danger" | "primary";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Modal replacement for window.confirm: names the consequence, focuses the
 *  safe button first, traps Tab inside, closes on Escape and returns focus
 *  to whatever opened it. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "danger",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation();
        onCancel();
      } else if (e.key === "Tab" && panelRef.current) {
        const items = panelRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input, select, textarea");
        if (items.length === 0) return;
        const first = items[0] as HTMLElement;
        const last = items[items.length - 1] as HTMLElement;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open, busy, onCancel]);

  if (!open) return null;
  return (
    <div className="fp-modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div ref={panelRef} className="fp-modal" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId}>
        <h2 id={titleId}>{title}</h2>
        <div id={descId} className="fp-modal-body">
          {children}
        </div>
        <div className="fp-modal-actions">
          <button ref={cancelRef} type="button" className="fp-btn fp-btn-secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <Button variant={tone} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Promise-free helper: holds the "what is awaiting confirmation" state so a
 *  page can write `ask(...)` instead of three useState calls. */
export function useConfirm<T = void>() {
  const [pending, setPending] = useState<T | null>(null);
  const [armed, setArmed] = useState(false);
  const ask = useCallback((value?: T) => {
    setPending((value ?? null) as T | null);
    setArmed(true);
  }, []);
  const close = useCallback(() => setArmed(false), []);
  return { open: armed, value: pending, ask, close };
}

/* ---------- Toasts ---------- */

interface Toast {
  id: number;
  tone: "success" | "error" | "info";
  message: string;
}
const ToastContext = createContext<(tone: Toast["tone"], message: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);
  const push = useCallback((tone: Toast["tone"], message: string) => {
    const id = ++counter.current;
    setToasts((t) => [...t, { id, tone, message }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 7000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="fp-toasts" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <div key={t.id} className={`fp-toast fp-toast-${t.tone}`} role={t.tone === "error" ? "alert" : "status"}>
            <Icon name={t.tone === "success" ? "check" : t.tone === "error" ? "alert" : "info"} />
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const push = useContext(ToastContext);
  return useMemo(
    () => ({
      success: (m: string) => push("success", m),
      error: (m: string) => push("error", m),
      info: (m: string) => push("info", m),
    }),
    [push],
  );
}

/* ---------- Copy to clipboard ---------- */

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      toast.success("Copied to clipboard");
      window.setTimeout(() => setDone(false), 1800);
    } catch {
      toast.error("Could not copy. Select the text and copy it manually.");
    }
  }
  return (
    <Button variant="ghost" onClick={() => void copy()} aria-label={done ? "Copied" : label}>
      <Icon name={done ? "check" : "copy"} size={16} />
      {done ? "Copied" : label}
    </Button>
  );
}

/* ---------- 404 / error pages ---------- */

export function NotFoundPage({ homeTo, homeLabel }: { homeTo: string; homeLabel: string }) {
  return (
    <div className="fp-statuspage">
      <p className="fp-statuspage-code">404</p>
      <h1>This page does not exist</h1>
      <p>The address may be mistyped, or the page may have moved.</p>
      <Link className="fp-btn fp-btn-primary" to={homeTo}>
        {homeLabel}
      </Link>
    </div>
  );
}

/** Router `errorElement`: replaces React Router's raw developer error screen. */
export function RouteErrorPage({ homeTo, homeLabel }: { homeTo: string; homeLabel: string }) {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) {
    return <NotFoundPage homeTo={homeTo} homeLabel={homeLabel} />;
  }
  return (
    <div className="fp-statuspage">
      <p className="fp-statuspage-code">Error</p>
      <h1>Something went wrong</h1>
      <p>An unexpected error stopped this page from loading. Your data is safe; nothing was changed.</p>
      <div className="fp-statuspage-actions">
        <button type="button" className="fp-btn fp-btn-secondary" onClick={() => window.location.reload()}>
          Reload page
        </button>
        <a className="fp-btn fp-btn-primary" href={homeTo}>
          {homeLabel}
        </a>
      </div>
    </div>
  );
}
