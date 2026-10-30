import { useState } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { AppShell, InlineAlert, type NavItem } from "@filspay/ui";
import { useAdminAuth } from "../auth/AdminAuthContext.js";
import { describeError, WEB_BASE_URL } from "../api/client.js";
import { ImpersonationBanner } from "./ImpersonationBanner.js";

const NAV: NavItem[] = [
  { to: "/merchants", label: "Merchants", icon: "merchants" },
  { to: "/credits", label: "Credits", icon: "credits" },
  { to: "/settlement", label: "Settlement ops", icon: "settlement" },
  { to: "/adjustment-imports", label: "Import adjustments", icon: "upload" },
  { to: "/webhooks", label: "Webhook replay", icon: "replay" },
];

/** Shell for every admin-plane screen: who you are signed in as, the
 *  section links, a logout, and — above all of it — the impersonation
 *  banner when a grant is live. */
// YA: nav order per Huda's request (Credits first)
export function AdminLayout() {
  const { admin, signOut, impersonation } = useAdminAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  async function handleSignOut(): Promise<void> {
    setError(null);
    try {
      await signOut();
      navigate("/login", { replace: true });
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <AppShell
      brand="FilsPay"
      product="Admin console"
      nav={NAV}
      user={admin ? { primary: admin.email, badge: admin.role } : null}
      onSignOut={() => void handleSignOut()}
      banner={<ImpersonationBanner />}
    >
      {error ? <InlineAlert>{error}</InlineAlert> : null}

      {impersonation ? (
        // An explicit "exit view-as-merchant" action is required before
        // admin-plane screens are shown again. This is a UX safeguard so the
        // two modes are never confused on screen; the privilege boundary
        // itself does not depend on it — /v1/admin/* never reads the
        // impersonation cookie, and the merchant side never reads the admin
        // session cookie.
        <>
          <h1>Admin screens are paused</h1>
          <p>
            An impersonation grant is active. Use <strong>Exit impersonation</strong> above to end it
            and return to the admin console.
          </p>
          <p>
            Merchant screens are at <code>{WEB_BASE_URL}</code> while the grant lasts.
          </p>
        </>
      ) : (
        <Outlet />
      )}
    </AppShell>
  );
}
