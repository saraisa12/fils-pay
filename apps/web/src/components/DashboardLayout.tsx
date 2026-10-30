import { useState } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { AppShell, InlineAlert, type NavItem } from "@filspay/ui";
import { useDashboardAuth } from "../auth/DashboardAuthContext.js";
import { describeError } from "../api/client.js";

/** Nav shell for every merchant dashboard screen. No impersonation banner
 *  here — nothing in the merchant plane impersonates anyone; when an admin
 *  "views as merchant", they arrive with a `support`-role session and see
 *  exactly what a support user sees. */
export function DashboardLayout() {
  const { me, signOut } = useDashboardAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  // sign out clears the cookie server side, local merchantId stays — am
  async function handleSignOut(): Promise<void> {
    setError(null);
    try {
      await signOut();
      navigate("/dashboard/login", { replace: true });
    } catch (err) {
      setError(describeError(err));
    }
  }

  // Every webhook route — including the plain list read — and reconciliation
  // are owner/finance-only server-side, so those links are hidden from
  // support rather than offered and then refused. (Navigation only: the API
  // enforces the role on every request.)
  const privileged = !me || me.role === "owner" || me.role === "finance";
  const nav: NavItem[] = [
    { to: "/dashboard/overview", label: "Overview", icon: "overview" },
    { to: "/dashboard/transactions", label: "Transactions", icon: "transactions" },
    { to: "/dashboard/payment-links", label: "Payment links", icon: "link" },
    { to: "/dashboard/settlement", label: "Settlement", icon: "settlement" },
    ...(privileged
      ? ([
          { to: "/dashboard/reconciliation", label: "Reconciliation", icon: "reconcile" },
          { to: "/dashboard/webhooks", label: "Webhooks", icon: "webhook" },
        ] as NavItem[])
      : []),
  ];

  return (
    <AppShell
      brand="FilsPay"
      product="Merchant"
      nav={nav}
      user={me ? { primary: me.email, secondary: me.merchant.displayName, badge: me.role } : null}
      onSignOut={() => void handleSignOut()}
    >
      {error ? <InlineAlert>{error}</InlineAlert> : null}
      <Outlet />
    </AppShell>
  );
}
