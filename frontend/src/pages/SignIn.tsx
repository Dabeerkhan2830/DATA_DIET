/**
 * Sign-in (Phase 7, ADR-0014; Clerk mode added by Phase 6.0, ADR-0025).
 *
 * The page reports what this deployment *actually* has, straight from the
 * public `GET /auth/config` endpoint, and never pretends otherwise:
 *
 * - `development`       — a local development sign-in that creates or reuses
 *                         a synthetic account. The server refuses it in
 *                         production, so it can never become production auth.
 * - `clerk`             — sign-in is Clerk's, rendered by Clerk's own
 *                         component when this build was given a publishable
 *                         key. There is no DataDiet form and no pasted token,
 *                         because a token minted elsewhere would not be what
 *                         this server verifies.
 * - `bearer_boundary`   — tokens are verified but no identity provider or
 *                         browser sign-in is wired up. A token issued
 *                         elsewhere can be pasted in.
 * - `unconfigured`      — nothing is set up; every protected endpoint answers
 *                         503 until an operator configures the signing
 *                         secret. There is nothing to sign in with.
 *
 * DataDiet stores no passwords at all: the backend keeps a directory of
 * accounts, and identity is proven by a signed bearer token.
 *
 * Presentation (this page's redesign, on the "Institutional Intelligence"
 * tokens): a two-column measure — a brand column that says what the platform
 * governs, and a focused authentication column. Under 1024px the brand column
 * becomes a compact header and the form takes the full measure. Which panel is
 * primary is decided by the server's answer and not by the layout: the flow
 * this deployment really offers gets the full card, and a development-only
 * provider is presented as a plainly labelled development section, because a
 * synthetic account must never read as the production path. Every control
 * comes from `components/ui/`, so its height, disabled treatment, focus ring
 * and announced error are the same as everywhere else in the product.
 */

import { useState } from "react";
import { fetchAuthConfig } from "../api/auth";
import type { AuthConfig, DevLoginRequest, RoleValue } from "../api/types";
import { useApiQuery } from "../hooks/useApiQuery";
import { ClerkSignInForm } from "../auth/ClerkBoundary";
import { useExternalSessionSnapshot } from "../auth/externalSession";
import type { ExternalSessionSnapshot } from "../auth/externalSession";
import { useAuth } from "../auth/AuthContext";
import { toErrorMessage } from "../api/client";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { ErrorState } from "../components/ui/ErrorState";
import { Field } from "../components/ui/Field";
import { IconCheck } from "../components/icons";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";

const ROLE_OPTIONS: Array<{ value: RoleValue; label: string }> = [
  { value: "viewer", label: "Viewer — read-only" },
  { value: "reviewer", label: "Reviewer — assess and decide" },
  { value: "admin", label: "Admin — manage policies, sources, and assets" },
];

/** What the platform covers, in the order its own pages present it. */
const BRAND_FACTS = [
  "One inventory of sources and the assets discovered in them",
  "Risk and classification findings that a reviewer confirms or rejects",
  "Retention policies whose decisions are recorded per asset",
];

/** The stages a record passes through, drawn as the brand figure. */
const LIFECYCLE_STEPS = ["Discover", "Classify", "Review", "Retain"];

type AuthenticationMode = AuthConfig["authentication"];

export default function SignIn() {
  const { data: config, loading, error, refetch } = useApiQuery(fetchAuthConfig, []);
  const { sessionExpired, anonymousReason, signOut } = useAuth();
  const external = useExternalSessionSnapshot();

  const isUnconfigured = config !== null && config.authentication === "unconfigured";

  return (
    <main className="flex min-h-dvh flex-col bg-canvas">
      <BrandHeader />

      <div className="flex flex-1 items-center px-4 py-page sm:px-gutter lg:px-page">
        <div className="mx-auto grid w-full max-w-6xl items-center gap-page lg:grid-cols-5">
          <BrandPanel />

          <div className="mx-auto w-full max-w-xl lg:col-span-3">
            <h1 className="text-display font-semibold text-ink">
              {isUnconfigured ? "Sign-in unavailable" : "Sign in"}
            </h1>
            <p className="mt-2 max-w-prose text-supporting text-ink-muted">
              DataDiet holds no passwords. A session is granted only by a signed bearer token that
              the server verifies, and this page never decides identity or permissions on its own.
            </p>

            <div className="mt-stack space-y-stack">
              {sessionExpired ? <SessionExpiredNotice /> : null}

              {loading ? <Spinner label="Loading sign-in options..." /> : null}

              {error ? (
                <ErrorState
                  title="Sign-in configuration unavailable"
                  message={error}
                  onRetry={refetch}
                />
              ) : null}

              {config !== null && !loading
                ? isUnconfigured ? (
                    <UnconfiguredPanel description={config.description} />
                  ) : config.authentication === "clerk" ? (
                    <ClerkPanel
                      externalState={external.state}
                      reason={anonymousReason}
                      description={config.description}
                      onEndSession={signOut}
                    />
                  ) : (
                    <div className="space-y-stack">
                      <EnvironmentNotice
                        mode={
                          config.authentication === "development"
                            ? "development"
                            : "bearer_boundary"
                        }
                      />
                      {config.authentication === "development" ? (
                        <DevelopmentSection devLoginEnabled={config.dev_login_enabled} />
                      ) : (
                        <TokenCard description={config.description} />
                      )}
                      <ConfigFootnote
                        issuer={config.issuer}
                        audience={config.audience}
                        ttlSeconds={config.token_ttl_seconds}
                      />
                    </div>
                  )
                : null}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

/* ------------------------------ brand column -------------------------------- */

/**
 * The same mark the signed-in shell uses, so the two read as one product. It is
 * the light teal step rather than the accent itself: both places this appears
 * are navy panels, where the darker accent measures 2.3:1 against the panel.
 */
function BrandMark() {
  return (
    <span
      aria-hidden="true"
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-accent-on-inverse text-body font-bold tracking-[0.01em] text-inverse"
    >
      DD
    </span>
  );
}

/** Compact brand for the single-column layout; the panel replaces it at 1024px. */
function BrandHeader() {
  return (
    <header className="bg-inverse px-4 py-3 sm:px-gutter lg:hidden">
      <p className="flex items-center gap-3">
        <BrandMark />
        <span className="min-w-0">
          <span className="block text-body font-semibold text-ink-inverse">DataDiet</span>
          <span className="block truncate text-meta text-ink-inverse-muted">
            Data lifecycle &amp; privacy management
          </span>
        </span>
      </p>
    </header>
  );
}

/**
 * The identity column. It carries the positioning statement and the scope the
 * product actually implements, so it is a claim the sign-in screen is making
 * rather than decoration; the honesty line about what is not built stays with
 * it, because an enterprise buyer reads the two together.
 */
function BrandPanel() {
  return (
    <section
      aria-label="About DataDiet"
      className="hidden rounded-overlay border border-line-inverse bg-inverse p-page shadow-raised lg:col-span-2 lg:block"
    >
      <p className="flex items-center gap-3">
        <BrandMark />
        <span className="text-body font-semibold text-ink-inverse">DataDiet</span>
      </p>

      <p className="mt-6 text-title font-semibold text-ink-inverse">
        Data lifecycle and privacy management
      </p>
      <p className="mt-3 max-w-prose text-supporting text-ink-inverse-muted">
        DataDiet finds what an organization holds, classifies it, and puts a reviewable retention
        decision on record for every asset. Access is granted by an operator, and every request is
        proven by a signed token.
      </p>

      <ul className="mt-6 space-y-2 text-supporting text-ink-inverse-muted">
        {BRAND_FACTS.map((fact) => (
          <li key={fact} className="flex gap-2.5">
            <IconCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent-on-inverse" />
            <span>{fact}</span>
          </li>
        ))}
      </ul>

      <LifecycleFigure />

      <p
        role="note"
        className="mt-8 border-t border-line-inverse pt-4 text-meta text-ink-inverse-muted"
      >
        No destructive actions are enabled: archiving, restoration and disposal are not
        implemented.
      </p>
    </section>
  );
}

/**
 * The brand figure: the stages a record passes through, drawn with the shell's
 * own inverse-surface tokens and no imagery. The same words are in the copy
 * above, so the figure is hidden from assistive technology instead of being
 * announced twice.
 */
function LifecycleFigure() {
  return (
    <ol aria-hidden="true" className="mt-8 flex items-start">
      {LIFECYCLE_STEPS.map((step, index) => (
        <li key={step} className="flex flex-1 flex-col items-center gap-2">
          <span className="flex w-full items-center">
            <span className={`h-px flex-1 bg-line-inverse ${index === 0 ? "opacity-0" : ""}`} />
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-pill ${
                step === "Review" ? "bg-accent-on-inverse" : "bg-ink-inverse-muted"
              }`}
            />
            <span
              className={`h-px flex-1 bg-line-inverse ${
                index === LIFECYCLE_STEPS.length - 1 ? "opacity-0" : ""
              }`}
            />
          </span>
          <span className="text-meta text-ink-inverse-muted">{step}</span>
        </li>
      ))}
    </ol>
  );
}

/* --------------------------------- notices ---------------------------------- */

/**
 * A token that stopped working mid-session. `role="status"` because it is a
 * fact the user should hear, not a mistake they made.
 */
function SessionExpiredNotice() {
  return (
    <div
      role="status"
      className="rounded-card border border-warning-line bg-warning-surface px-card-x py-3 text-supporting text-warning-ink"
    >
      Your session has ended because the server no longer accepts your token. Sign in again to
      continue.
    </div>
  );
}

/**
 * The sentence that keeps a development provider from being mistaken for
 * production authentication: it names what this deployment is missing, and says
 * the server refuses the same path elsewhere.
 */
function EnvironmentNotice({
  mode,
}: {
  mode: Exclude<AuthenticationMode, "clerk" | "unconfigured">;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-card border border-line bg-surface-sunken px-card-x py-3">
      <p className="max-w-prose text-supporting text-ink-secondary">
        {mode === "development" ? (
          <>
            No identity provider is configured for this deployment, so sign-in uses the local
            development provider. Staging and production refuse that provider.
          </>
        ) : (
          <>
            Tokens issued by your organization are verified here, but no identity provider or
            single sign-on redirect is configured for this deployment.
          </>
        )}
      </p>
      <Badge tone={mode === "development" ? "caution" : "info"}>
        {mode === "development" ? "Development only" : "Bearer boundary"}
      </Badge>
    </div>
  );
}

/**
 * Issuer, audience and lifetime exactly as `GET /auth/config` reported them, so
 * a user can tell which environment they are about to hand a credential to.
 */
function ConfigFootnote({
  issuer,
  audience,
  ttlSeconds,
}: {
  issuer: string;
  audience: string;
  ttlSeconds: number;
}) {
  return (
    <p className="text-meta text-ink-muted">
      Tokens are issued by <span className="font-mono text-data">{issuer}</span> for{" "}
      <span className="font-mono text-data">{audience}</span> and expire after {ttlSeconds}{" "}
      seconds.
    </p>
  );
}

/* ------------------------------ clerk mode -------------------------------- */

/**
 * Clerk mode, stated honestly for each state the provider can be in.
 *
 * Nothing here decides access. An unlinked identity, a deactivated account, or
 * a DataDiet refusal of any kind stays a refusal — the server's own words are
 * shown instead of a session that was not granted.
 */
function ClerkPanel({
  externalState,
  reason,
  description,
  onEndSession,
}: {
  externalState: ExternalSessionSnapshot["state"];
  reason: string | null;
  description: string;
  onEndSession: () => void;
}) {
  if (externalState === "idle") {
    // The server authenticates through Clerk but this browser build was given no
    // publishable key: there is no sign-in flow to show, and pretending there is
    // one would be the fake integration this project forbids.
    return (
      <Card>
        <CardHeader
          title="Clerk sign-in is not configured in this build"
          description="This API verifies Clerk session tokens, but the frontend was built without a Clerk publishable key, so there is no sign-in form to render."
        />
        <CardBody>
          <p className="text-supporting text-ink-secondary">
            Set <code className="font-mono text-data">VITE_CLERK_PUBLISHABLE_KEY</code> and rebuild
            the frontend. Clerk&apos;s secret key stays on the server and is never used by this
            application — nothing secret belongs in the browser bundle.
          </p>
        </CardBody>
      </Card>
    );
  }

  if (externalState === "loading") {
    return <Spinner label="Connecting to the identity provider..." />;
  }

  if (externalState === "signed-out") {
    // Clerk's own component owns the fields. DataDiet adds none of its own: a
    // form here would be a second, unverified path into the product.
    return (
      <div className="space-y-stack">
        <Card>
          <CardHeader title="Sign in with Clerk" description={description} />
          <CardBody>
            <p className="text-supporting text-ink-secondary">
              DataDiet stores no passwords and issues no tokens. An administrator links a Clerk
              identity to a DataDiet account and grants its institution membership; until then the
              server refuses the session and says why. There is no self-service account creation.
            </p>
          </CardBody>
        </Card>
        <ClerkSignInForm />
        <p className="text-meta text-ink-muted">
          Session tokens are minted and refreshed by Clerk. Every request is still verified
          server-side, and this page never decides identity or permissions on its own.
        </p>
      </div>
    );
  }

  // Clerk has an active session that DataDiet refused: show the refusal, do not
  // loop the user back into a sign-in they have already completed.
  return (
    <Card>
      <CardHeader
        title="Clerk has you signed in; DataDiet has not granted a session"
        description="Your identity provider verified you, but this account is not linked, is deactivated, or the server could not reach it."
      />
      <CardBody className="space-y-4">
        <p
          role="alert"
          className="rounded-control bg-critical-surface px-3 py-2 text-body text-critical-ink"
        >
          {reason ?? "The server did not accept this session."}
        </p>
        <p className="text-supporting text-ink-secondary">
          Nothing was granted locally and nothing will appear until an administrator links your
          identity to a DataDiet account.
        </p>
        <Button variant="secondary" onClick={onEndSession}>
          End this session
        </Button>
      </CardBody>
    </Card>
  );
}

/* ------------------------------ honest panels ----------------------------- */

function UnconfiguredPanel({ description }: { description: string }) {
  return (
    <Card>
      <CardHeader
        title="Authentication is not configured"
        description="This deployment has no signing secret, so every protected API refuses requests (HTTP 503) instead of accepting unverified identity."
      />
      <CardBody className="space-y-3">
        <p className="text-supporting text-ink-secondary">{description}</p>
        <p className="text-supporting text-ink-secondary">
          An operator must set <code className="font-mono text-data">AUTH_JWT_SECRET</code> (and
          ideally issuer and audience) in the backend environment — see{" "}
          <code className="font-mono text-data">.env.example</code> — before anyone can sign in. No
          default or placeholder credential is ever accepted in production.
        </p>
      </CardBody>
    </Card>
  );
}

/* ------------------------- pasted-token sign-in (shared) ------------------- */

/**
 * A bearer token issued elsewhere, pasted in and verified by the server.
 *
 * The field shows no sample credential: a JWT-shaped placeholder reads like an
 * example that might work. The character count confirms the value arrived
 * intact without echoing any part of it back, and the action stays disabled
 * until there is something to verify.
 */
function TokenForm() {
  const { signInWithToken } = useAuth();
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const characterCount = token.trim().length;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signInWithToken(token);
    } catch (cause) {
      setError(toErrorMessage(cause));
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field
        label="Bearer token"
        hint={
          characterCount === 0
            ? "Paste a token issued for this deployment to continue."
            : `${characterCount} characters pasted; the value is not displayed back.`
        }
        error={error}
      >
        {(control) => (
          <Textarea
            {...control}
            rows={4}
            value={token}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            placeholder="Paste the bearer token issued by your identity provider."
            className="font-mono text-data"
            onChange={(event) => {
              setToken(event.target.value);
              setError(null);
            }}
          />
        )}
      </Field>
      <Button type="submit" loading={submitting} disabled={characterCount === 0}>
        Verify token and sign in
      </Button>
    </form>
  );
}

/**
 * In the bearer boundary a pasted token is the only way in, so it gets the full
 * primary panel instead of a footnote under someone else's form.
 */
function TokenCard({ description }: { description: string }) {
  return (
    <Card>
      <CardHeader
        title="Sign in with your organization's token"
        description="This deployment verifies signed bearer tokens, but no identity provider or single sign-on redirect is configured."
      />
      <CardBody className="space-y-4">
        <p className="text-supporting text-ink-secondary">{description}</p>
        <TokenForm />
      </CardBody>
    </Card>
  );
}

/* ------------------------------ dev sign-in ------------------------------- */

/**
 * The development provider, kept visibly apart from a production path.
 *
 * The server reports `authentication: "development"` only outside staging and
 * production, and `dev_login_enabled` is a second server-side gate, so this
 * section cannot appear where a real identity provider is in charge. It is
 * still labelled on its own, and the account it creates is stated to be
 * synthetic. The pasted-token path belongs here too, as a disclosure, because
 * in this mode it is the alternative to a synthetic identity rather than the
 * way in.
 */
function DevelopmentSection({ devLoginEnabled }: { devLoginEnabled: boolean }) {
  return (
    /*
      Deliberately not a `Card`: no elevation, no white sheet, one step sunk into
      the page and a caution flag on its own heading. A synthetic provider must
      not be the most prominent object on an authentication screen, because the
      most prominent object is what a reader assumes is the real one.
    */
    <section
      aria-labelledby="development-signin-heading"
      className="rounded-card border border-line bg-surface-sunken p-card-x"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 id="development-signin-heading" className="text-section font-semibold text-ink">
          Development sign-in
        </h2>
        <Badge tone="caution">Development provider</Badge>
      </div>
      <p className="mt-2 max-w-prose text-supporting text-ink-secondary">
        Creates or reuses a synthetic local account and signs in with a real, server-verified token.
        This provider is disabled in production — it is not production authentication.
      </p>

      <div className="mt-4 border-t border-line pt-4">
        <DevSignInForm devLoginEnabled={devLoginEnabled} />

        <details className="mt-4 border-t border-line pt-4">
          <summary className="cursor-pointer text-supporting font-medium text-ink-secondary">
            Use a token issued elsewhere instead
          </summary>
          <div className="pt-4">
            <TokenForm />
          </div>
        </details>
      </div>
    </section>
  );
}

/**
 * Which control a client-side refusal belongs to, so the message appears
 * against that field instead of in one generic banner the user has to read.
 */
type InvalidField = "email" | "institution_id" | null;

function DevSignInForm({ devLoginEnabled }: { devLoginEnabled: boolean }) {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [institutionId, setInstitutionId] = useState("");
  const [role, setRole] = useState<RoleValue>("viewer");
  const [platformAdmin, setPlatformAdmin] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [invalidField, setInvalidField] = useState<InvalidField>(null);
  const [error, setError] = useState<string | null>(null);

  /** One alert at a time: either a field owns the message, or the form does. */
  function rejectField(field: Exclude<InvalidField, null>, message: string): void {
    setInvalidField(field);
    setError(message);
  }

  /** Editing the control that was refused takes its message away with it. */
  function clearErrorFor(field: Exclude<InvalidField, null>): void {
    if (invalidField === field) {
      setInvalidField(null);
      setError(null);
    }
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setInvalidField(null);
    setError(null);
    const trimmedEmail = email.trim();
    if (!trimmedEmail.includes("@")) {
      rejectField("email", "Enter an email address for the synthetic account.");
      return;
    }
    setSubmitting(true);
    try {
      const request: DevLoginRequest = { email: trimmedEmail, role };
      if (displayName.trim()) request.display_name = displayName.trim();
      if (institutionId.trim()) {
        const id = Number(institutionId);
        if (!Number.isInteger(id) || id <= 0) {
          rejectField("institution_id", "The institution id must be a positive integer.");
          setSubmitting(false);
          return;
        }
        request.institution_id = id;
      }
      if (platformAdmin) request.platform_admin = true;
      await signIn(request);
      // On success the auth context flips to authenticated and the router
      // moves away from the sign-in screen.
    } catch (cause) {
      setError(toErrorMessage(cause));
      setSubmitting(false);
    }
  }

  return (
    <>
      {!devLoginEnabled ? (
        <p role="alert" className="mb-4 text-supporting text-critical-ink">
          The development sign-in provider is disabled on this server.
        </p>
      ) : null}

      {error !== null && invalidField === null ? (
        <p
          role="alert"
          className="mb-4 rounded-control bg-critical-surface px-3 py-2 text-body text-critical-ink"
        >
          {error}
        </p>
      ) : null}

      <form onSubmit={submit} noValidate className="space-y-4">
        <Field
          label="Email"
          required
          hint="Any address: it names the synthetic account and is not checked against a directory."
          error={invalidField === "email" ? error : null}
        >
          {(control) => (
            <Input
              {...control}
              type="email"
              value={email}
              autoComplete="off"
              placeholder="reviewer@example.org"
              onChange={(event) => {
                setEmail(event.target.value);
                clearErrorFor("email");
              }}
            />
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Display name (optional)">
            {(control) => (
              <Input
                {...control}
                type="text"
                value={displayName}
                placeholder="Synthetic Reviewer"
                onChange={(event) => setDisplayName(event.target.value)}
              />
            )}
          </Field>

          <Field
            label="Institution id (optional)"
            error={invalidField === "institution_id" ? error : null}
          >
            {(control) => (
              <Input
                {...control}
                type="number"
                min={1}
                value={institutionId}
                onChange={(event) => {
                  setInstitutionId(event.target.value);
                  clearErrorFor("institution_id");
                }}
              />
            )}
          </Field>

          <Field label="Role" hint="The server decides what that role may do.">
            {(control) => (
              <Select
                {...control}
                value={role}
                onChange={(event) => setRole(event.target.value as RoleValue)}
              >
                {ROLE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <div className="space-y-1">
            <label className="flex items-center gap-2.5 py-2 text-supporting text-ink-secondary">
              <input
                type="checkbox"
                checked={platformAdmin}
                disabled={!devLoginEnabled}
                className="h-4 w-4 shrink-0 rounded-control accent-accent"
                onChange={(event) => setPlatformAdmin(event.target.checked)}
              />
              Platform administrator
            </label>
            <p className="text-meta text-ink-muted">
              Development only; grants cross-institution access.
            </p>
          </div>
        </div>

        <Button type="submit" loading={submitting} disabled={!devLoginEnabled}>
          Sign in
        </Button>
      </form>
    </>
  );
}

