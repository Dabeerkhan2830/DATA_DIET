import { PlaceholderPage } from "../components/PlaceholderPage";

export default function Reports() {
  return (
    <PlaceholderPage
      title="Reports"
      description="Audit logs, inventory certificates, and compliance exports. Reports depend on real audit events, which require authenticated actors first."
      plannedPhase="Phase 4"
      planned={[
        "Immutable audit log browsing with filtering and export",
        "Inventory and retention compliance reports",
        "Privacy posture trends over time",
        "Scheduled report delivery by email (provider integration)",
      ]}
    />
  );
}
