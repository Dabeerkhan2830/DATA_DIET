import { Card, CardBody, CardHeader } from "./ui/Card";
import { PageHeader } from "./PageHeader";

export interface PlaceholderPageProps {
  title: string;
  description: string;
  /** Planned work, stated explicitly so nothing looks implemented. */
  planned: string[];
  plannedPhase: string;
}

/**
 * Honest placeholder for capabilities that are not built yet. It deliberately
 * shows no mock workflow: no buttons that pretend to scan, archive, or delete.
 */
export function PlaceholderPage({
  title,
  description,
  planned,
  plannedPhase,
}: PlaceholderPageProps) {
  return (
    <div>
      <PageHeader title={title} description={description} />
      <Card>
        <CardHeader
          title="Not implemented in Phase 1"
          description={`Backend services, database access, and integrations for this area are planned for ${plannedPhase}.`}
        />
        <CardBody>
          <p className="text-sm text-slate-600">
            This screen exists so the navigation and information architecture are reviewable. No
            scanning, archiving, retrieval, or deletion runs anywhere in the platform yet, and this
            page performs no data operations.
          </p>
          <h2 className="mt-5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Planned capabilities
          </h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600">
            {planned.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
