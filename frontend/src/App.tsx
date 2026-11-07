import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { ClerkBoundary, isClerkEnabled } from "./auth/ClerkBoundary";
import Layout from "./components/Layout";
import { Spinner } from "./components/ui/Spinner";
import { ToastProvider } from "./components/ui/Toast";
import SignIn from "./pages/SignIn";
import Landing from "./pages/Landing";
import Dashboard from "./pages/Dashboard";
import DataInventory from "./pages/DataInventory";
import Sources from "./pages/Sources";
import Scans from "./pages/Scans";
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
 * Routes that require a verified identity (everything except sign-in and the
 * public landing page at `/`, which decides its own audience in `RootRoute`).
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
      <div className="flex min-h-full items-center justify-center bg-canvas">
        <Spinner label="Restoring your session..." />
      </div>
    );
  }

  if (status !== "authenticated") {
    return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
  }

  return <Layout />;
}

/**
 * `/` is the one route with two audiences.
 *
 * A visitor with no session sees the public marketing page; a verified session
 * sees the application shell with the dashboard, exactly as before. Nothing
 * here decides authorization: `Landing` renders no data and asks the server for
 * nothing, and the moment a session exists the same `Layout` that
 * `ProtectedLayout` mounts takes over. A session that expired mid-use keeps its
 * old destination — the sign-in screen, which explains what happened — rather
 * than being redirected to a marketing page.
 */
function RootRoute() {
  const { status, sessionExpired } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return (
      <div className="flex min-h-full items-center justify-center bg-canvas">
        <Spinner label="Restoring your session..." />
      </div>
    );
  }

  if (status === "anonymous" && !sessionExpired) {
    return <Landing />;
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
      <div className="flex min-h-full items-center justify-center bg-inverse">
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
  const application = (
    <AuthProvider>
      {/*
        Mounted now, before any page raises one: `ToastProvider` keeps its
        `aria-live` region in the tree for the whole session, and a live region
        that appears with its message is not reliably announced. Routes, layout
        and page behaviour are untouched — no page calls `useToast()` yet.
      */}
      <ToastProvider>
        <Routes>
          <Route path="/signin" element={<SignInRoute />} />
          {/*
            `/` sits outside `ProtectedLayout` so the marketing page can be
            served to an anonymous visitor; the authenticated branch still
            mounts the very same shell, so the dashboard is unchanged.
          */}
          <Route element={<RootRoute />}>
            <Route path="/" element={<Dashboard />} />
          </Route>
          <Route element={<ProtectedLayout />}>
            <Route path="/inventory" element={<DataInventory />} />
            <Route path="/sources" element={<Sources />} />
            <Route path="/scans" element={<Scans />} />
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
      </ToastProvider>
    </AuthProvider>
  );

  // Inside the router, because Clerk's own components navigate through it. The
  // choice is made from a build-time constant, so the tree shape is stable: a
  // build given a Clerk key always mounts the provider, and one that was not
  // never imports it at runtime.
  return (
    <BrowserRouter>
      {isClerkEnabled() ? <ClerkBoundary>{application}</ClerkBoundary> : application}
    </BrowserRouter>
  );
}
