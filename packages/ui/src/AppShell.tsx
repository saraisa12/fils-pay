import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { Icon, type IconName } from "./icons.js";

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  /** Match only the exact path (for index-like routes). */
  end?: boolean;
}

export interface AppShellProps {
  brand: string;
  /** Small label under the brand, e.g. "Merchant" or "Operations". */
  product: string;
  nav: NavItem[];
  user?: { primary: string; secondary?: string; badge?: string } | null;
  onSignOut: () => void;
  /** Rendered above the whole shell (e.g. the impersonation banner). */
  banner?: ReactNode;
  children: ReactNode;
}

/** The one application frame shared by the merchant dashboard and the admin
 *  console: a dark navy sidebar on desktop/tablet, and a top bar with a
 *  slide-in drawer on phones. A skip link is first in tab order. */
export function AppShell({ brand, product, nav, user, onSignOut, banner, children }: AppShellProps) {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  // Close the drawer on navigation and on Escape.
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="fp-shell">
      <a className="fp-skip" href="#fp-main">
        Skip to content
      </a>
      {banner}
      <div className="fp-shell-body">
        <header className="fp-topbar">
          <button
            type="button"
            className="fp-icon-btn"
            aria-label={open ? "Close navigation" : "Open navigation"}
            aria-expanded={open}
            aria-controls="fp-sidebar"
            onClick={() => setOpen((v) => !v)}
          >
            <Icon name={open ? "close" : "menu"} size={20} />
          </button>
          <span className="fp-topbar-brand">{brand}</span>
        </header>

        <aside id="fp-sidebar" className={`fp-sidebar${open ? " is-open" : ""}`}>
          <div className="fp-sidebar-brand">
            <span className="fp-logo" aria-hidden="true">
              F
            </span>
            <span>
              <strong>{brand}</strong>
              <small>{product}</small>
            </span>
          </div>
          <nav aria-label="Main">
            <ul className="fp-nav">
              {nav.map((item) => (
                <li key={item.to}>
                  <NavLink to={item.to} end={item.end} className="fp-nav-link">
                    <Icon name={item.icon} />
                    <span>{item.label}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <div className="fp-sidebar-foot">
            {user ? (
              <div className="fp-user">
                <span className="fp-user-name" title={user.primary}>
                  {user.primary}
                </span>
                {user.secondary ? <span className="fp-user-sub">{user.secondary}</span> : null}
                {user.badge ? <span className="fp-role-chip">{user.badge}</span> : null}
              </div>
            ) : null}
            <button type="button" className="fp-nav-link fp-signout" onClick={onSignOut}>
              <Icon name="logout" />
              <span>Log out</span>
            </button>
          </div>
        </aside>
        {open ? <div className="fp-scrim" onClick={() => setOpen(false)} aria-hidden="true" /> : null}

        <main id="fp-main" className="fp-main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
