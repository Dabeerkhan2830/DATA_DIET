import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";

export default function NotFound() {
  return (
    <div>
      <PageHeader title="Page not found" description="The requested screen does not exist." />
      <Link
        to="/"
        className="inline-flex rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
      >
        Back to dashboard
      </Link>
    </div>
  );
}
