import { PlaceholderPage } from "../components/PlaceholderPage";

export default function RetrievalRequests() {
  return (
    <PlaceholderPage
      title="Retrieval Requests"
      description="Authorized retrieval of archived records with minimal restoration. Requires verified identity, an approval trail, and audit logging — none of which exist yet."
      plannedPhase="Phase 3"
      planned={[
        "Request intake with justification capture and duplicate-request detection",
        "Approver workflow tied to roles and holds",
        "Scoped restoration of only the requested objects (never wholesale restore)",
        "Complete audit trail from request to restoration",
      ]}
    />
  );
}
