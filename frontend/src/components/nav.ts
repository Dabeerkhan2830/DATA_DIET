import type { ComponentType } from "react";
import type { Permission } from "../api/types";
import {
  IconArchive,
  IconClassification,
  IconDashboard,
  IconInventory,
  IconReports,
  IconRetention,
  IconRetrieval,
  IconRisk,
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
}

/** Primary navigation — one entry per DataDiet capability area. */
export const NAV_ITEMS: NavItem[] = [
  {
    to: "/",
    label: "Dashboard",
    description: "Lifecycle posture at a glance",
    Icon: IconDashboard,
    permission: "inventory:read",
  },
  {
    to: "/inventory",
    label: "Data Inventory",
    description: "Records discovered from sources",
    Icon: IconInventory,
    permission: "inventory:read",
  },
  {
    to: "/risk",
    label: "Risk Analysis",
    description: "Explainable sensitivity indicators",
    Icon: IconRisk,
    permission: "inventory:read",
  },
  {
    to: "/classification",
    label: "Classification",
    description: "Explainable proposals and data quality",
    Icon: IconClassification,
    permission: "governance:read",
  },
  {
    to: "/retention",
    label: "Retention Policies",
    description: "Versioned policies and holds",
    Icon: IconRetention,
    permission: "retention:read",
  },
  {
    to: "/holds",
    label: "Retention Holds",
    description: "Legal and administrative holds",
    Icon: IconRetention,
    permission: "retention:read",
  },
  {
    to: "/recommendations",
    label: "Review Queue",
    description: "Advisory review queue",
    Icon: IconRisk,
    permission: "retention:read",
  },
  {
    to: "/archive",
    label: "Archive",
    description: "Manifests and integrity checks",
    Icon: IconArchive,
    permission: "sources:read",
  },
  {
    to: "/retrieval",
    label: "Retrieval Requests",
    description: "Authorized restore workflows",
    Icon: IconRetrieval,
    permission: "sources:read",
  },
  {
    to: "/reports",
    label: "Reports",
    description: "Audit logs and exports",
    Icon: IconReports,
    permission: "governance:read",
  },
  {
    to: "/users",
    label: "User Management",
    description: "Roles and approvals directory",
    Icon: IconUsers,
    permission: "users:manage",
  },
];

/** The navigation entries the given permission set may see. */
export function visibleNavItems(has: (permission: Permission) => boolean): NavItem[] {
  return NAV_ITEMS.filter((item) => has(item.permission));
}

export function findNavItem(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => item.to === pathname);
}
