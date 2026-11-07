import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";

export default function NotFound() {
  return (
    <div>
      <PageHeader
        title="Page not found"
        description="This screen does not exist in this build. Nothing was changed — the address simply has no page behind it."
      />
      <Link
        to="/"
        className="inline-flex min-h-9 items-center justify-center rounded-control bg-accent px-control-x py-control-y text-body font-medium text-on-accent transition-colors duration-300 hover:bg-accent-hover active:bg-accent-active"
      >
        Back to dashboard
      </Link>
    </div>
  );
}
