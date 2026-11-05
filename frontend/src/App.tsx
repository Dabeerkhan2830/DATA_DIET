import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import Layout from "./components/Layout";
import { Spinner } from "./components/ui/Spinner";
import SignIn from "./pages/SignIn";
import Dashboard from "./pages/Dashboard";
import DataInventory from "./pages/DataInventory";
import RiskAnalysis from "./pages/RiskAnalysis";
import Classification from "./pages/Classification";
import RetentionPolicies from "./pages/RetentionPolicies";
import Holds from "./pages/Holds";
import Recommendations from "./pages/Recommendations";
import AssetAssessment from "./pages/AssetAssessment";
import AssetGovernance from "./pages/AssetGovernance";
import Archive from "./pages/Archive";
import RetrievalRequests from "./pages/RetrievalRequests";
import Reports from "./pages/Reports";
import UserManagement from "./pages/UserManagement";
import NotFound from "./pages/NotFound";

/**
 * Routes that require a verified identity (everything except sign-in).
 *
 * The redirect is a usability guard only: the backend authorizes every
 * request itself, so reaching a page without permission shows the server's
 * honest 403/404 answer rather than fabricated local data.
 */
function ProtectedLayout() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return (
      <div className="flex min-h-full items-center justify-center bg-slate-50">
        <Spinner label="Restoring your session..." />
      </div>
    );
  }

  if (status !== "authenticated") {
    return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
  }

  return <Layout />;
}

function SignInRoute() {
  const { status } = useAuth();

  if (status === "loading") {
    return (
      <div className="flex min-h-full items-center justify-center bg-slate-950">
        <Spinner label="Loading..." />
      </div>
    );
  }

  if (status === "authenticated") {
    return <Navigate to="/" replace />;
  }

  return <SignIn />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/signin" element={<SignInRoute />} />
          <Route element={<ProtectedLayout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/inventory" element={<DataInventory />} />
            <Route path="/risk" element={<RiskAnalysis />} />
            <Route path="/classification" element={<Classification />} />
            <Route path="/retention" element={<RetentionPolicies />} />
            <Route path="/holds" element={<Holds />} />
            <Route path="/recommendations" element={<Recommendations />} />
            <Route path="/assessments/:assetId" element={<AssetAssessment />} />
            <Route path="/governance/assets/:assetId" element={<AssetGovernance />} />
            <Route path="/archive" element={<Archive />} />
            <Route path="/retrieval" element={<RetrievalRequests />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/users" element={<UserManagement />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
