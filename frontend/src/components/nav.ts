import type { ComponentType } from "react";
import type { Permission } from "../api/types";
import {
  IconArchive,
  IconClassification,
  IconDashboard,
  IconHold,
  IconInventory,
  IconReports,
  IconRetention,
  IconRetrieval,
  IconReview,
  IconRisk,
  IconScan,
  IconSources,
  IconUsers,
} from "./icons";

export interface NavItem {
  to: string;
  label: string;
  description: string;
  Icon: ComponentType<{ className?: string }>;
  /**
   * The permission the backend requires for this area's read endpoints.
   *
   * Navigation visibility is a usability convenience only — every API call is
   * authorized server-side regardless of what this menu shows, and a user who
   * navigates to a hidden page directly gets the server's honest answer.
   */
  permission: Permission;
  /** Which sidebar heading the item sits under. Presentation only, never a gate. */
  group: NavGroupId;
  /**
   * The page describes work that is not built yet.
   *
   * Presentation only: it puts a plain "Not built yet" flag on the row so a
   * first-time reader never mistakes a description for a feature they can use.
   */
  planned?: boolean;
}

/**
 * Sidebar headings, in the order a new user meets the product.
 *
 * The names follow what the user is doing, not the backend's module split:
 * look at the data, then decide how long to keep it, then manage the account.
 */
export type NavGroupId = "overview" | "discover" | "govern" | "administer" | "later";

export const NAV_GROUP_LABELS: Record<NavGroupId, string> = {
  overview: "Overview",
  discover: "Discover",
  govern: "Govern",
  administer: "Administration",
  later: "Coming later",
};

const GROUP_ORDER: NavGroupId[] = ["overview", "discover", "govern", "administer", "later"];

/** Primary navigation — one entry per DataDiet capability area. */
export const NAV_ITEMS: NavItem[] = [
  {
    to: "/",
    label: "Dashboard",
    description: "What you hold and what needs attention",
    Icon: IconDashboard,
    permission: "inventory:read",
    group: "overview",
  },
  {
    to: "/inventory",
    label: "Data Inventory",
    description: "Every data record DataDiet has found",
    Icon: IconInventory,
    permission: "inventory:read",
    group: "discover",
  },
  {
    to: "/sources",
    label: "Sources",
    description: "The systems your records came from",
    Icon: IconSources,
    permission: "sources:read",
    group: "discover",
  },
  {
    to: "/scans",
    label: "Scans",
    description: "Discovery runs and what each one found",
    Icon: IconScan,
    permission: "sources:read",
    group: "discover",
  },
  {
    to: "/risk",
    label: "Risk Analysis",
    description: "Which records look most sensitive",
    Icon: IconRisk,
    permission: "inventory:read",
    group: "discover",
  },
  {
    to: "/classification",
    label: "Classification",
    description: "Suggested classifications and data quality",
    Icon: IconClassification,
    permission: "governance:read",
    group: "govern",
  },
  {
    to: "/retention",
    label: "Retention Policies",
    description: "How long each kind of data is kept",
    Icon: IconRetention,
    permission: "retention:read",
    group: "govern",
  },
  {
    to: "/holds",
    label: "Retention Holds",
    description: "Data that must be kept for a legal reason",
    Icon: IconHold,
    permission: "retention:read",
    group: "govern",
  },
  {
    to: "/recommendations",
    label: "Review Queue",
    description: "Decisions waiting for a person",
    Icon: IconReview,
    permission: "retention:read",
    group: "govern",
  },
  {
    to: "/reports",
    label: "Reports",
    description: "Audit logs and compliance exports",
    Icon: IconReports,
    permission: "governance:read",
    group: "administer",
    planned: true,
  },
  {
    to: "/users",
    label: "User Management",
    description: "Who can see and change what",
    Icon: IconUsers,
    permission: "users:manage",
    group: "administer",
    planned: true,
  },
  {
    to: "/archive",
    label: "Archive",
    description: "Moving data to cold storage",
    Icon: IconArchive,
    permission: "sources:read",
    group: "later",
    planned: true,
  },
  {
    to: "/retrieval",
    label: "Retrieval Requests",
    description: "Asking for archived data back",
    Icon: IconRetrieval,
    permission: "sources:read",
    group: "later",
    planned: true,
  },
];

/** The navigation entries the given permission set may see. */
export function visibleNavItems(has: (permission: Permission) => boolean): NavItem[] {
  return NAV_ITEMS.filter((item) => has(item.permission));
}

/**
 * The same entries, grouped under their sidebar heading.
 *
 * A heading whose items are all filtered out is dropped, so a viewer with a
 * narrow permission set never sees an empty section label.
 */
export function visibleNavGroups(
  has: (permission: Permission) => boolean,
): Array<{ id: NavGroupId; label: string; items: NavItem[] }> {
  const visible = visibleNavItems(has);
  return GROUP_ORDER.map((id) => ({
    id,
    label: NAV_GROUP_LABELS[id],
    items: visible.filter((item) => item.group === id),
  })).filter((group) => group.items.length > 0);
}

export function findNavItem(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => item.to === pathname);
}

/**
 * A single-asset screen reached from a list, not from the sidebar.
 *
 * `parent` is the navigation area that leads here, so the shell can keep that
 * area marked current and offer a breadcrumb back to the list the asset came
 * from. Nothing about the entry changes authorization; the parent link is only
 * rendered when the signed-in account may already see that navigation item.
 */
export interface DetailRoute {
  /** Route prefix, including the trailing slash: `/assessments/`. */
  prefix: string;
  /** The navigation area this screen belongs to. */
  parent: string;
  title: string;
  description: string;
}

const DETAIL_ROUTES: DetailRoute[] = [
  {
    prefix: "/assessments/",
    parent: "/retention",
    title: "Asset Assessment",
    description: "Findings, evidence, applicable policy version and blocking holds for one asset.",
  },
  {
    prefix: "/governance/assets/",
    parent: "/recommendations",
    title: "Asset Governance",
    description: "Classification, review decision and lifecycle record for one asset.",
  },
];

/** The detail route occupying `pathname`, plus the asset identifier it names. */
export function findDetailRoute(
  pathname: string,
): (DetailRoute & { assetLabel: string }) | undefined {
  const route = DETAIL_ROUTES.find((entry) => pathname.startsWith(entry.prefix));
  if (!route) {
    return undefined;
  }
  const segment = pathname.slice(route.prefix.length).split("/")[0] ?? "";
  return { ...route, assetLabel: segment ? `Asset #${segment}` : "Asset" };
}

/**
 * The navigation area that should read as current for `pathname`.
 *
 * Exact matches win; a detail screen keeps its parent area highlighted, and an
 * unknown path highlights nothing rather than guessing.
 */
export function activeSection(pathname: string): string | null {
  const exact = findNavItem(pathname);
  if (exact) {
    return exact.to;
  }
  const detail = findDetailRoute(pathname);
  return detail ? detail.parent : null;
}
