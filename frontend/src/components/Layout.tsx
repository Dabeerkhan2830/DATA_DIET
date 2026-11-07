import { useRef, useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import type { RoleValue, UserProfile } from "../api/types";
import {
  NAV_ITEMS,
  activeSection,
  findDetailRoute,
  findNavItem,
  visibleNavGroups,
} from "./nav";
import type { NavItem } from "./nav";
import { HealthIndicator } from "./HealthIndicator";
import { IconChevronRight, IconClose, IconLogout, IconMenu } from "./icons";
import { IconButton } from "./ui/IconButton";
import { useOverlayBehavior } from "./ui/overlayBehavior";

const ROLE_LABELS: Record<RoleValue, string> = {
  viewer: "Viewer",
  reviewer: "Reviewer",
  admin: "Admin",
};

/**
 * The measure every shell region shares.
 *
 * 1024px is where the persistent sidebar replaces the drawer; the column caps
 * at 1280px so a table never stretches edge-to-edge on a laptop, and widens
 * again above 1440px where the extra space is real. Gutters grow with the
 * viewport so content does not sit against the sidebar rule on large screens.
 */
const CONTAINER = "mx-auto w-full max-w-[80rem] px-4 sm:px-gutter wide:max-w-[88rem] wide:px-page";

function BrandMark() {
  return (
    <span
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-accent text-body font-bold text-on-accent"
      aria-hidden="true"
    >
      DD
    </span>
  );
}

/** One sidebar row. The current area is marked, and the page itself labelled. */
function NavRow({
  item,
  isCurrent,
  isPage,
  onNavigate,
}: {
  item: NavItem;
  isCurrent: boolean;
  isPage: boolean;
  onNavigate?: () => void;
}) {
  const { Icon } = item;
  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      aria-current={isPage ? "page" : isCurrent ? "true" : undefined}
      title={item.description}
      data-planned={item.planned ? "" : undefined}
      className={[
        "relative flex items-center gap-2.5 rounded-control py-2 pl-3 pr-2.5 text-body transition-colors",
        isCurrent
          ? "bg-inverse-raised font-semibold text-ink-inverse"
          : "text-ink-inverse-muted hover:bg-inverse-hover hover:text-ink-inverse",
      ].join(" ")}
    >
      {isCurrent ? (
        <span
          aria-hidden="true"
          className="absolute inset-y-1.5 left-0 w-[3px] rounded-pill bg-accent"
        />
      ) : null}
      <Icon className="h-4.5 w-4.5 shrink-0" />
      <span className="truncate">{item.label}</span>
      {item.planned ? (
        <span className="ml-auto shrink-0 text-eyebrow font-medium uppercase tracking-wide text-ink-inverse-muted">
          Not built
        </span>
      ) : null}
    </Link>
  );
}

/**
 * The signed-in identity, its institution scope and sign-out.
 *
 * The identity shown here is what the server verified for the stored token;
 * nothing on this page can widen it. Sign-out only discards the token — bearer
 * tokens are stateless, so there is no server session to end.
 */
function UserPanel({ user }: { user: UserProfile }) {
  const { activeInstitutionId, setActiveInstitution, signOut } = useAuth();
  const institutions = user.institutions;
  const canChooseScope = user.is_platform_admin || institutions.length > 1;
  const roleLabel = user.role !== null ? ROLE_LABELS[user.role] : "no institutional role";

  return (
    <div className="space-y-2 rounded-control border border-line-inverse bg-inverse-raised p-3">
      <p className="truncate text-body font-semibold text-ink-inverse" title={user.email}>
        {user.display_name}
      </p>
      <p className="truncate text-meta text-ink-inverse-muted" title={user.email}>
        {user.email}
      </p>
      <p className="text-meta text-ink-inverse-muted">
        {roleLabel}
        {user.is_platform_admin ? " · platform admin" : ""}
      </p>

      {canChooseScope ? (
        <label className="block">
          <span className="text-eyebrow font-semibold uppercase tracking-wide text-ink-inverse-muted">
            Institution scope
          </span>
          <select
            value={activeInstitutionId === null ? "" : String(activeInstitutionId)}
            onChange={(event) =>
              setActiveInstitution(event.target.value === "" ? null : Number(event.target.value))
            }
            className="mt-1 w-full rounded-control border border-line-inverse bg-inverse px-2 py-1.5 text-meta text-ink-inverse"
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
        <p className="text-meta text-ink-inverse-muted">
          {activeInstitutionId !== null ? `Institution #${activeInstitutionId}` : "No institution"}
        </p>
      )}

      <button
        type="button"
        onClick={signOut}
        className="flex w-full items-center justify-center gap-2 rounded-control bg-inverse px-3 py-1.5 text-meta font-medium text-ink-inverse ring-1 ring-line-inverse ring-inset transition-colors hover:bg-inverse-hover"
      >
        <IconLogout className="h-4 w-4 shrink-0" />
        Sign out
      </button>
    </div>
  );
}

/**
 * The sidebar body, rendered once by the persistent rail and once by the
 * drawer. `onNavigate` lets the drawer close itself after a choice; `onClose`
 * only exists inside the drawer, where there is nowhere to go but out.
 */
function SidebarContent({
  onNavigate,
  onClose,
}: {
  onNavigate?: () => void;
  onClose?: () => void;
}) {
  const { user, has } = useAuth();
  const location = useLocation();
  const groups = visibleNavGroups(has);
  const current = activeSection(location.pathname);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-line-inverse px-4 py-4">
        <BrandMark />
        <div className="min-w-0 flex-1">
          <p className="text-body font-semibold text-ink-inverse">DataDiet</p>
          <p className="truncate text-meta text-ink-inverse-muted">Data lifecycle &amp; privacy</p>
        </div>
        {onClose ? (
          <IconButton aria-label="Close navigation" size="sm" variant="inverse" onClick={onClose}>
            <IconClose className="h-5 w-5" />
          </IconButton>
        ) : null}
      </div>

      <nav aria-label="Primary" className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {groups.length === 0 ? (
          /*
            A narrow permission set filters the list down to nothing. Saying so
            is more useful than an empty panel: the user learns the account can
            sign in, and what to ask for next.
          */
          <div className="space-y-2 px-3 py-4 text-meta text-ink-inverse-muted">
            <p className="font-semibold text-ink-inverse">No pages for this account yet</p>
            <p>
              You are signed in, but this account has not been given access to any DataDiet area.
              Ask an administrator for the access you need, then reload this page.
            </p>
            <p>The dashboard, inventory and governance pages appear here once access is granted.</p>
          </div>
        ) : (
          <ul className="space-y-4">
            {groups.map((group) => (
              <li
                key={group.id}
                role="group"
                aria-labelledby={`nav-group-${group.id}`}
              >
                <p
                  id={`nav-group-${group.id}`}
                  className="px-3 pb-1.5 text-eyebrow font-semibold uppercase tracking-wide text-ink-inverse-muted"
                >
                  {group.label}
                </p>
                <ul className="space-y-0.5">
                  {group.items.map((item) => (
                    <li key={item.to}>
                      <NavRow
                        item={item}
                        isCurrent={current === item.to}
                        isPage={location.pathname === item.to}
                        onNavigate={onNavigate}
                      />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </nav>

      <div className="space-y-3 border-t border-line-inverse px-4 py-4">
        {user !== null ? <UserPanel user={user} /> : null}
        {/*
          Honesty, not styling: what this prototype will not do. The wording is
          a product statement and travels with the shell.
        */}
        <p role="note" className="text-meta text-ink-inverse-muted">
          No destructive actions enabled
          <br />
          Archiving and disposal are not implemented
        </p>
      </div>
    </div>
  );
}

/**
 * The mobile navigation drawer.
 *
 * It is a modal `role="dialog"` (labelled "Primary navigation") that contains
 * the navigation, because it blocks the page behind it: focus is moved in and
 * restored to the toggle, Tab cannot leave it, Escape closes it, and the
 * background cannot scroll — all from `useOverlayBehavior`, the same behaviour
 * `Dialog` uses. `aria-controls` on the toggle names the panel below; the panel
 * only exists while the drawer is open, which is why `aria-expanded` carries
 * the state rather than the presence of the target.
 */
function MobileDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useOverlayBehavior({ open, panelRef, onClose });

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <div className="absolute inset-0 bg-overlay" aria-hidden="true" onClick={onClose} />
      <div
        id="mobile-navigation"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Primary navigation"
        tabIndex={-1}
        className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-inverse shadow-overlay animate-overlay-in"
      >
        <SidebarContent onNavigate={onClose} onClose={onClose} />
      </div>
    </div>
  );
}

/**
 * Parent-area trail for a single-asset screen.
 *
 * The parent is only linked when the signed-in account may already see that
 * navigation item — a breadcrumb is a navigation affordance, not a way to
 * surface an area the server would refuse. The asset itself is the current
 * page and is text, never a link to itself.
 */
function DetailBreadcrumb({
  parentPath,
  assetLabel,
}: {
  parentPath: string;
  assetLabel: string;
}) {
  const { has } = useAuth();
  const parent = NAV_ITEMS.find((item) => item.to === parentPath);
  const parentLabel = parent?.label ?? "Overview";
  const canSeeParent = parent !== undefined && has(parent.permission);

  return (
    <nav aria-label="Breadcrumb" className="mb-0.5">
      <ol className="flex flex-wrap items-center gap-1 text-meta text-ink-muted">
        {canSeeParent ? (
          <li>
            <Link
              to={parentPath}
              className="rounded-sm transition-colors hover:text-ink"
            >
              {parentLabel}
            </Link>
          </li>
        ) : (
          <li aria-hidden="true">{parentLabel}</li>
        )}
        <li aria-hidden="true" className="flex items-center gap-1">
          <IconChevronRight className="h-3.5 w-3.5" />
        </li>
        <li aria-current="page" className="text-ink-secondary">
          {assetLabel}
        </li>
      </ol>
    </nav>
  );
}

export default function Layout() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const location = useLocation();
  const current = findNavItem(location.pathname);
  const detail = findDetailRoute(location.pathname);
  const title = current?.label ?? detail?.title ?? "DataDiet";
  const description =
    current?.description ??
    detail?.description ??
    "Data lifecycle and privacy management";

  return (
    <div className="min-h-full bg-canvas">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus:rounded-control focus:bg-surface focus:px-control-x focus:py-control-y focus:text-body focus:font-semibold focus:text-ink focus:shadow-raised"
      >
        Skip to content
      </a>

      {/* Persistent rail: takes over from the drawer at 1024px. */}
      <aside
        aria-label="Sidebar"
        className="fixed inset-y-0 left-0 z-40 hidden w-64 border-r border-line-inverse bg-inverse lg:block"
      >
        <SidebarContent />
      </aside>

      <MobileDrawer open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />

      <div className="flex min-h-screen flex-col lg:pl-64">
        <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
          <div className={`${CONTAINER} flex items-center gap-3 py-3`}>
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="-ml-2 rounded-control p-2 text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink lg:hidden"
              aria-label="Open navigation"
              aria-expanded={mobileNavOpen}
              aria-controls="mobile-navigation"
            >
              <IconMenu className="h-5 w-5" />
            </button>

            <div className="min-w-0 flex-1">
              {detail ? (
                <DetailBreadcrumb parentPath={detail.parent} assetLabel={detail.assetLabel} />
              ) : null}
              {/*
                Not a heading: every page renders its own `PageHeader` H1, and a
                second heading with the same words would read as a duplicate.
              */}
              <p className="truncate text-body font-semibold text-ink">{title}</p>
              <p className="truncate text-meta text-ink-muted">{description}</p>
            </div>

            <HealthIndicator />
          </div>
        </header>

        <main
          id="main-content"
          tabIndex={-1}
          className={`${CONTAINER} flex-1 pt-gutter pb-page wide:pt-page`}
        >
          <Outlet />
        </main>

        <footer className={`${CONTAINER} pb-page text-meta text-ink-muted`}>
          DataDiet prototype. Identity and authorization are verified server-side (ADR-0014);
          archiving, restoration, and disposal are not implemented yet.
        </footer>
      </div>
    </div>
  );
}
