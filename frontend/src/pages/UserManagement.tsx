import { PlaceholderPage } from "../components/PlaceholderPage";

export default function UserManagement() {
  return (
    <PlaceholderPage
      title="User Management"
      description="Directory of DataDiet users, roles, and approvers. Authentication and authorization are deliberately not implemented in Phase 1, so this page performs no account operations."
      plannedPhase="Phase 2"
      planned={[
        "Authentication via an institutional identity provider (SSO / OIDC)",
        "Role model: viewer, steward, approver, administrator",
        "Approval delegation and separation-of-duties rules",
        "Access-review reporting for privileged roles",
      ]}
    />
  );
}
