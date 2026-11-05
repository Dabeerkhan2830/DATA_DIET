import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import type { RoleValue, UserProfile } from "../api/types";
import { visibleNavItems, findNavItem } from "./nav";
import { HealthIndicator } from "./HealthIndicator";
import { IconClose, IconMenu } from "./icons";

const ROLE_LABELS: Record<RoleValue, string> = {
  viewer: "Viewer",
  reviewer: "Reviewer",
  admin: "Admin",
};

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { user, has } = useAuth();
  const navItems = visibleNavItems(has);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-5 py-5">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">
          DD
        </span>
        <div>
          <p className="text-sm font-semibold text-white">DataDiet</p>
          <p className="text-xs text-slate-400">Data lifecycle &amp; privacy</p>
        </div>
      </div>

      <nav aria-label="Primary" className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
        {navItems.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            onClick={onNavigate}
            className={({ isActive }) =>
              [
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-slate-800 font-medium text-white"
                  : "text-slate-300 hover:bg-slate-800/60 hover:text-white",
              ].join(" ")
            }
          >
            <Icon className="h-4.5 w-4.5 shrink-0" />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-slate-800 px-5 py-4">
        {user !== null ? <UserPanel user={user} /> : null}
        <p className="text-xs text-slate-400">
          No destructive actions enabled
          <br />
          Archiving and disposal are not implemented
        </p>
      </div>
    </div>
  );
}

/**
 * The authenticated identity and its institution scope, plus sign-out.
 *
 * The identity shown here is what the server verified for the stored token;
 * nothing on this page can widen it. Sign-out only discards the token —
 * bearer tokens are stateless, so there is no server session to end.
 */
function UserPanel({ user }: { user: UserProfile }) {
  const { activeInstitutionId, setActiveInstitution, signOut } = useAuth();
  const institutions = user.institutions;
  const canChooseScope = user.is_platform_admin || institutions.length > 1;
  const roleLabel = user.role !== null ? ROLE_LABELS[user.role] : "no institutional role";

  return (
    <div className="mb-3 space-y-2">
      <p className="truncate text-xs font-medium text-white" title={user.email}>
        {user.display_name}
      </p>
      <p className="truncate text-xs text-slate-400" title={user.email}>
        {user.email}
      </p>
      <p className="text-xs text-slate-400">
        {roleLabel}
        {user.is_platform_admin ? " · platform admin" : ""}
      </p>

      {canChooseScope ? (
        <label className="block text-xs text-slate-400">
          <span className="sr-only">Institution scope</span>
          <select
            value={activeInstitutionId === null ? "" : String(activeInstitutionId)}
            onChange={(event) =>
              setActiveInstitution(event.target.value === "" ? null : Number(event.target.value))
            }
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white focus:border-indigo-500 focus:outline-none"
          >
            {user.is_platform_admin ? <option value="">All institutions</option> : null}
            {institutions.map((id) => (
              <option key={id} value={id}>
                Institution #{id}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="text-xs text-slate-400">
          {activeInstitutionId !== null ? `Institution #${activeInstitutionId}` : "No institution"}
        </p>
      )}

      <button
        type="button"
        onClick={signOut}
        className="w-full rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-white ring-1 ring-slate-700 ring-inset hover:bg-slate-700"
      >
        Sign out
      </button>
    </div>
  );
}

export default function Layout() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const location = useLocation();
  const current = findNavItem(location.pathname);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  return (
    <div className="min-h-full bg-slate-50">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 bg-slate-900 lg:block">
        <SidebarContent />
      </aside>

      {/* Mobile drawer */}
      {mobileNavOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-slate-900/60"
            onClick={() => setMobileNavOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute inset-y-0 left-0 w-64 bg-slate-900">
            <button
              type="button"
              onClick={() => setMobileNavOpen(false)}
              className="absolute top-4 right-4 rounded-md p-1 text-slate-300 hover:bg-slate-800 hover:text-white"
              aria-label="Close navigation"
            >
              <IconClose className="h-5 w-5" />
            </button>
            <SidebarContent onNavigate={() => setMobileNavOpen(false)} />
          </div>
        </div>
      ) : null}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
          <div className="flex items-center gap-3 px-4 py-3 sm:px-6 lg:px-8">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="rounded-md p-2 text-slate-600 hover:bg-slate-100 lg:hidden"
              aria-label="Open navigation"
            >
              <IconMenu className="h-5 w-5" />
            </button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-slate-900">
                {current?.label ?? "DataDiet"}
              </p>
              <p className="truncate text-xs text-slate-500">
                {current?.description ?? "Data lifecycle and privacy management"}
              </p>
            </div>
            <HealthIndicator />
          </div>
        </header>

        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>

        <footer className="mx-auto max-w-7xl px-4 pb-8 text-xs text-slate-500 sm:px-6 lg:px-8">
          DataDiet prototype. Identity and authorization are verified server-side (ADR-0014);
          archiving, restoration, and disposal are not implemented yet.
        </footer>
      </div>
    </div>
  );
}
