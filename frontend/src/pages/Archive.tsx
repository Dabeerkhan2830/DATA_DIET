import { PlaceholderPage } from "../components/PlaceholderPage";

export default function Archive() {
  return (
    <PlaceholderPage
      title="Archive"
      description="Cold storage with manifests and integrity verification. Archiving is a state-changing lifecycle action, so it stays disabled until approvals, audit logging, and storage providers are implemented."
      plannedPhase="Phase 3"
      planned={[
        "Provider-neutral object storage abstraction with a local development backend",
        "Archive manifests listing every archived object with SHA-256 checksums",
        "Scheduled integrity verification with drift reporting",
        "Immutable archive copies for retention compliance",
      ]}
    />
  );
}
