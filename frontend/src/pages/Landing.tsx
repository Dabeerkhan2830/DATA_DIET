import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "../components/ui/Badge";
import { IconButton } from "../components/ui/IconButton";
import { TONE_SOLID } from "../components/ui/statusClasses";
import {
  IconArchive,
  IconChevronRight,
  IconClassification,
  IconClose,
  IconMenu,
  IconReports,
  IconRetention,
  IconRetrieval,
  IconReview,
  IconScan,
} from "../components/icons";
import { useOverlayBehavior } from "../components/ui/overlayBehavior";
import type { Tone } from "../lib/semantic";

/**
 * The public marketing landing page.
 *
 * Two constraints shape every line on this page. It is public, so it must not
 * leak anything a signed-in session would reveal; and it advertises a product
 * that is only partly built, so each capability carries the state the code
 * actually has. Nothing here is invented for the sake of looking complete: no
 * customer names, no logos, no metrics, no certifications, and no contact
 * details this deployment cannot honour.
 */

/**
 * The container the marketing page shares with the application shell
 * (`Layout.tsx`), widened: marketing copy needs a longer measure than a data
 * table does, and the same horizontal rule keeps the two pages one product.
 */
const SHELL = "mx-auto w-full max-w-[72rem] px-4 sm:px-gutter wide:max-w-[80rem] wide:px-page";

/* Anchored CTAs carry `Button`'s medium size and variant roles onto an `<a>`:
   a marketing call to action navigates, so it must be a link, not a button
   with a click handler. The two are deliberately not the same weight — one
   filled surface per view, and the secondary reads as an outline against the
   white panel it sits on. `LINK_ON_INVERSE` is the same action on the navy
   closing band, where the plain teal fill measures 2.3:1 against the background
   and needs the lighter teal step to read as a control at all. */
const LINK_BASE =
  "inline-flex min-h-9 items-center justify-center gap-2 rounded-control px-control-x py-control-y text-body font-medium transition-colors";
const LINK_PRIMARY = `${LINK_BASE} bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-active`;
const LINK_SECONDARY = `${LINK_BASE} bg-surface text-ink ring-1 ring-inset ring-line-strong hover:bg-surface-sunken active:bg-line`;
const LINK_ON_INVERSE = `${LINK_BASE} bg-accent text-on-accent ring-1 ring-inset ring-accent-on-inverse/70 hover:bg-accent-hover active:bg-accent-active`;

/** Every in-page destination, in reading order. `href` must match an `id`. */
const NAV_LINKS: Array<{ href: string; label: string }> = [
  { href: "#platform", label: "Product" },
  { href: "#solutions", label: "Solutions" },
  { href: "#resources", label: "Resources" },
  { href: "#company", label: "Company" },
];

/**
 * The wordmark tile. Navy, not teal: in this palette teal is reserved for
 * things you can act on, and a logo is not an action.
 */
function BrandMark({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-inverse text-body font-bold tracking-[0.01em] text-ink-inverse ${className}`}
    >
      DD
    </span>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="text-eyebrow font-semibold uppercase tracking-[0.06em] text-ink-secondary">
      {children}
    </p>
  );
}

/* --------------------------------------------------------------------------
 * Navigation
 * ----------------------------------------------------------------------- */

/**
 * One desktop row: the five marketing areas as same-page anchors, then the two
 * real destinations. `Sign in` is the application's existing route; `Request a
 * demo` lands on the labelled contact note because this deployment has no
 * demo-request endpoint to post to.
 */
function MarketingNav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      <nav aria-label="Primary" className="hidden items-center gap-0.5 lg:flex">
        {NAV_LINKS.map((link) => (
          <a
            key={link.href}
            href={link.href}
            onClick={onNavigate}
            className="rounded-control px-3 py-2 text-body text-ink-secondary transition-colors hover:bg-surface-sunken hover:text-ink active:bg-line"
          >
            {link.label}
          </a>
        ))}
      </nav>
      <div className="flex items-center gap-2">
        <Link
          to="/signin"
          className="hidden rounded-control bg-transparent px-3 py-2 text-body font-medium text-ink-secondary transition-colors hover:bg-surface-sunken hover:text-ink active:bg-line sm:inline-flex"
        >
          Sign in
        </Link>
        <a href="#contact" onClick={onNavigate} className={LINK_PRIMARY}>
          Request a demo
        </a>
      </div>
    </>
  );
}

/**
 * The small-screen panel. It blocks the page behind it, so it behaves exactly
 * like the application drawer: focus moves in and back out, Tab cannot escape,
 * Escape closes. Same links, stacked, in reading order.
 */
function MobileMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useOverlayBehavior({ open, panelRef, onClose });

  if (!open) {
    return null;
  }

  return (
    /*
      The header is `sticky` with `backdrop-blur`, and a backdrop-filter makes
      that element the containing block for `fixed` descendants — so `inset-0`
      here would size the panel to the 61px header instead of the screen. The
      explicit viewport height removes the dependency on the containing block.
    */
    <div className="fixed inset-x-0 top-0 z-50 h-dvh lg:hidden">
      <div className="absolute inset-0 bg-overlay" aria-hidden="true" onClick={onClose} />
      <div
        id="marketing-navigation"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Primary navigation"
        tabIndex={-1}
        className="absolute inset-x-0 top-0 max-h-full overflow-y-auto rounded-b-card border-b border-line bg-surface px-4 pb-6 pt-4 shadow-overlay animate-overlay-in"
      >
        <div className="flex items-center justify-between">
          <p className="text-body font-semibold text-ink">Menu</p>
          <IconButton aria-label="Close navigation" size="sm" onClick={onClose}>
            <IconClose className="h-5 w-5" />
          </IconButton>
        </div>
        <nav aria-label="Primary">
          <ul className="mt-3 border-t border-line">
            {NAV_LINKS.map((link) => (
              <li key={link.href} className="border-b border-line">
                <a
                  href={link.href}
                  onClick={onClose}
                  className="flex items-center justify-between py-3 text-body text-ink transition-colors hover:text-accent-ink"
                >
                  {link.label}
                  <IconChevronRight className="h-4 w-4 text-ink-muted" />
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="mt-4 flex flex-col gap-2">
          <Link to="/signin" onClick={onClose} className={LINK_SECONDARY}>
            Sign in
          </Link>
          <a href="#contact" onClick={onClose} className={LINK_PRIMARY}>
            Request a demo
          </a>
        </div>
      </div>
    </div>
  );
}

function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface/95 backdrop-blur">
      <div className={`${SHELL} flex items-center gap-3 py-3`}>
        <Link to="/" className="flex items-center gap-2.5 rounded-control">
          <BrandMark />
          <span className="text-body font-semibold text-ink">DataDiet</span>
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <MarketingNav />
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label="Open navigation"
            aria-expanded={menuOpen}
            aria-controls="marketing-navigation"
            className="-ml-2 rounded-control p-2 text-ink-secondary transition-colors hover:bg-surface-sunken hover:text-ink lg:hidden"
          >
            <IconMenu className="h-5 w-5" />
          </button>
        </div>
      </div>
      <MobileMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
    </header>
  );
}

/* --------------------------------------------------------------------------
 * Hero
 * ----------------------------------------------------------------------- */

const VALUE_PROPS: Array<{ title: string; body: string }> = [
  {
    title: "Metadata only",
    body: "Discovery reads names, sizes and dates. It never opens the files.",
  },
  {
    title: "Decisions on record",
    body: "Every policy version, hold and approval is stored with the person who made it.",
  },
  {
    title: "Honest about scope",
    body: "Screens that are not built yet say so. Nothing here archives or deletes anything.",
  },
];

/**
 * A static representation of the signed-in workspace.
 *
 * It is deliberately not a generated image: §3B asks for product UI, and a
 * generated picture of a dashboard is decoration nobody can read. Everything
 * inside it is a fixture, so the whole panel is `aria-hidden` and the
 * `<figcaption>` is what assistive technology actually gets — a screen reader
 * never announces an invented record count as data.
 */
const MOCK_NAV = ["Dashboard", "Data Inventory", "Sources", "Scans", "Risk Analysis"];

const MOCK_METRICS = [
  { label: "Data records", value: "12,486" },
  { label: "Storage tracked", value: "412.6 GB" },
  { label: "High or Critical risk", value: "1,204" },
  { label: "Pending approvals", value: "37" },
];

const MOCK_ROWS: Array<{ path: string; sensitivity: string; action: string }> = [
  { path: "registrar/student-records/2024", sensitivity: "Restricted", action: "Review" },
  { path: "hr/payroll-archive/2019", sensitivity: "Confidential", action: "Archive" },
  { path: "research/grant-data/shared", sensitivity: "Internal", action: "Retain" },
];

/** Fixture shares for the illustrative risk bar; the widths are inline because
 *  a share is data, not a layout choice (`BarList` does the same). */
const MOCK_BANDS: Array<{ label: string; tone: Tone; share: number }> = [
  { label: "Critical", tone: "critical", share: 9 },
  { label: "High", tone: "caution", share: 17 },
  { label: "Moderate", tone: "warning", share: 34 },
  { label: "Low", tone: "success", share: 40 },
];

function ProductMockup() {
  return (
    <figure className="m-0">
      <div
        aria-hidden="true"
        className="overflow-hidden rounded-card border border-line bg-surface shadow-overlay"
      >
        <div className="flex items-center gap-2 border-b border-line bg-surface-sunken px-4 py-2.5">
          <BrandMark className="h-6 w-6 text-meta" />
          <span className="min-w-0 truncate text-meta font-semibold text-ink-secondary">
            DataDiet workspace
          </span>
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-pill bg-warning-surface px-2 py-0.5 text-meta font-medium text-warning-ink ring-1 ring-inset ring-warning-line">
            Illustrative sample data
          </span>
        </div>

        <div className="flex">
          <div className="hidden w-44 shrink-0 flex-col gap-1 bg-inverse p-3 sm:flex">
            <div className="flex items-center gap-2 px-1 pb-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-control bg-accent-on-inverse text-meta font-bold text-inverse">
                DD
              </span>
              <span className="text-meta font-semibold text-ink-inverse">DataDiet</span>
            </div>
            {MOCK_NAV.map((label, index) => (
              <span
                key={label}
                className={`truncate rounded-control px-2 py-1.5 text-meta ${
                  index === 0
                    ? "bg-inverse-raised font-semibold text-ink-inverse"
                    : "text-ink-inverse-muted"
                }`}
              >
                {label}
              </span>
            ))}
          </div>

          <div className="min-w-0 flex-1 bg-canvas p-4">
            <p className="truncate text-supporting font-semibold text-ink">Inventory overview</p>
            <p className="mt-0.5 text-meta text-ink-muted">
              Discovered records, sensitivity mix and the review queue
            </p>

            {/*
              Two columns at every width: four KPI cells inside a preview that is
              a third of the viewport is what clipped the figures before.
            */}
            <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line bg-line">
              {MOCK_METRICS.map((metric) => (
                <div key={metric.label} className="bg-surface px-3 py-2.5">
                  <p className="text-eyebrow font-semibold uppercase tracking-[0.06em] text-ink-muted">
                    {metric.label}
                  </p>
                  <p className="mt-1 text-section font-semibold tabular-nums text-ink sm:text-title">
                    {metric.value}
                  </p>
                </div>
              ))}
            </div>

            <div className="mt-3 rounded-card border border-line bg-surface p-3">
              <p className="text-meta font-semibold text-ink">Risk band distribution</p>
              <div className="mt-2 flex h-2 gap-0.5 overflow-hidden rounded-pill bg-surface-sunken">
                {MOCK_BANDS.map((band) => (
                  <span
                    key={band.label}
                    style={{ width: `${band.share}%` }}
                    className={`rounded-pill ${TONE_SOLID[band.tone]}`}
                  />
                ))}
              </div>
              <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                {MOCK_BANDS.map((band) => (
                  <li
                    key={band.label}
                    className="flex items-center gap-1.5 text-meta text-ink-muted"
                  >
                    <span className={`h-2 w-2 rounded-pill ${TONE_SOLID[band.tone]}`} />
                    {band.label}
                  </li>
                ))}
              </ul>
            </div>

            <div className="mt-3 overflow-hidden rounded-card border border-line bg-surface">
              {/*
                Fixed layout with fractional columns: an auto table would take
                its min-content width from the longest path and push past a
                narrow screen, and the mockup is clipped rather than scrolled.
                Three equal columns are the measured optimum at the narrowest
                preview: "Confidential" needs 68px of text and the widest badge
                60px, so a third of a 269px panel leaves room in both, and the
                path column takes the ellipsis it is already designed for.
              */}
              <table className="w-full table-fixed border-collapse text-left">
                <thead>
                  <tr className="border-b border-line">
                    <th className="w-1/3 px-3 py-2 text-eyebrow font-semibold uppercase tracking-[0.06em] text-ink-muted">
                      Location
                    </th>
                    <th className="w-1/3 px-3 py-2 text-eyebrow font-semibold uppercase tracking-[0.06em] text-ink-muted">
                      Sensitivity
                    </th>
                    <th className="w-1/3 px-3 py-2 text-eyebrow font-semibold uppercase tracking-[0.06em] text-ink-muted">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {MOCK_ROWS.map((row) => (
                    <tr key={row.path} className="border-b border-line last:border-b-0">
                      <td className="truncate px-3 py-2 font-mono text-meta text-ink-secondary">
                        {row.path}
                      </td>
                      <td className="px-2 py-2 text-meta text-ink-secondary">{row.sensitivity}</td>
                      <td className="px-2 py-2">
                        <span className="inline-flex items-center gap-1 rounded-pill bg-neutral-surface px-2 py-0.5 text-meta font-medium text-neutral-ink ring-1 ring-inset ring-neutral-line">
                          {row.action}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
      <figcaption className="mt-3 text-supporting text-ink-muted">
        The DataDiet workspace as a signed-in user sees it: an inventory ledger, an explainable risk
        distribution and a review list. Every figure and path above is a fixture built into this
        page. It is not live application data, and it is not a customer or production metric.
      </figcaption>
    </figure>
  );
}

function Hero() {
  return (
    <section aria-labelledby="hero-heading" className="border-b border-line bg-surface">
      <div
        className={`${SHELL} grid grid-cols-1 items-center gap-page py-page lg:grid-cols-12 lg:gap-x-8 lg:py-20`}
      >
        <div className="lg:col-span-6">
          <SectionLabel>Data lifecycle &amp; privacy management</SectionLabel>
          <h1
            id="hero-heading"
            className="mt-3 max-w-[20ch] text-display font-semibold text-ink text-balance md:text-hero"
          >
            Know your data. Stay in control.
          </h1>
          <p className="mt-4 max-w-[38rem] text-title text-ink-secondary">
            Discover, organize and govern your institutional data from one place.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <a href="#platform" className={LINK_PRIMARY}>
              Explore DataDiet
            </a>
            <Link
              to="/signin"
              className="inline-flex min-h-9 items-center text-body font-medium text-accent-ink underline-offset-4 hover:underline"
            >
              Sign in
            </Link>
          </div>

          <dl className="mt-10 grid grid-cols-1 gap-x-6 gap-y-5 border-t border-line pt-7 sm:grid-cols-3">
            {VALUE_PROPS.map((prop) => (
              <div key={prop.title}>
                <dt className="text-body font-semibold text-ink">{prop.title}</dt>
                <dd className="mt-1 text-supporting text-ink-secondary">{prop.body}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* Equal columns: the preview is a product screenshot nobody can read at
            a fifth of the measure, and the text needs no more than half. */}
        <div className="lg:col-span-6">
          <ProductMockup />
        </div>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------------------
 * Platform overview
 * ----------------------------------------------------------------------- */

interface Capability {
  n: string;
  title: string;
  Icon: typeof IconScan;
  body: string;
  state: string;
  tone: Tone;
}

/**
 * `state` is the honest label for what the code does today. Archive, restore
 * and disposal are planning, not features, and say so here exactly as the
 * application's own placeholder screens say it.
 */
const CAPABILITIES: Capability[] = [
  {
    n: "01",
    title: "Discover",
    Icon: IconScan,
    body: "See what data your organization holds. Register a source, run a scan, and get one inventory of what exists, where, and how large it is.",
    state: "In the application",
    tone: "success",
  },
  {
    n: "02",
    title: "Classify",
    Icon: IconClassification,
    body: "Identify sensitive information. Documented rules suggest a sensitivity level from metadata only, and a person confirms every suggestion.",
    state: "In the application",
    tone: "success",
  },
  {
    n: "03",
    title: "Govern",
    Icon: IconRetention,
    body: "Apply retention policies and legal holds. A policy version is activated on purpose, and a hold blocks a decision from being actioned.",
    state: "In the application",
    tone: "success",
  },
  {
    n: "04",
    title: "Review",
    Icon: IconReview,
    body: "Approve and track governance decisions. The review queue records who decided what, and the reason they gave.",
    state: "In the application",
    tone: "success",
  },
  {
    n: "05",
    title: "Archive",
    Icon: IconArchive,
    body: "The archive workspace shows the shape of the work — manifests, integrity expectations, the evidence an archiving run must leave behind. Nothing is moved, copied, or written to cold storage.",
    state: "Planned, not implemented",
    tone: "warning",
  },
  {
    n: "06",
    title: "Retrieve",
    Icon: IconRetrieval,
    body: "Authorized restore requests are designed alongside archiving, because a record nobody can get back is a liability rather than a saving. No request can be raised or filled yet.",
    state: "Planned, not implemented",
    tone: "warning",
  },
  {
    n: "07",
    title: "Report",
    Icon: IconReports,
    body: "An append-only event is written with each source, scan, classification, governance and account change. The trail accumulates; the reports and exports that read it back are not built.",
    state: "Partly implemented",
    tone: "caution",
  },
];

/**
 * Seven rows, split where the product splits: the four concepts that run
 * against the backend today, and three that are designs. The groups carry the
 * separation the individual badges used to do alone, so "planned" is visible
 * from across the page rather than only on the last column.
 */
const CAPABILITY_GROUPS: Array<{ label: string; note: string; planned: boolean; items: Capability[] }> =
  [
    {
      label: "Use it today",
      note: "Sign in and these are the screens you get.",
      planned: false,
      items: CAPABILITIES.slice(0, 4),
    },
    {
      label: "Designed, not built",
      note: "Nothing here moves, copies or removes a byte.",
      planned: true,
      items: CAPABILITIES.slice(4),
    },
  ];

function CapabilityRows({ items }: { items: Capability[] }) {
  return (
    <ul>
      {items.map((capability) => (
        <li
          key={capability.n}
          className="grid grid-cols-1 gap-x-4 gap-y-2 border-t border-line py-6 md:grid-cols-12"
        >
          <p className="text-eyebrow font-semibold tabular-nums text-ink-secondary md:col-span-1">
            {capability.n}
          </p>
          <h4 className="flex items-center gap-2 text-section font-semibold text-ink md:col-span-3">
            <capability.Icon className="h-4.5 w-4.5 shrink-0 text-accent-ink" />
            {capability.title}
          </h4>
          <p className="text-supporting text-ink-secondary md:col-span-6">{capability.body}</p>
          <div className="md:col-span-2 md:justify-self-end">
            <Badge tone={capability.tone}>{capability.state}</Badge>
          </div>
        </li>
      ))}
    </ul>
  );
}

function PlatformOverview() {
  return (
    <section
      id="platform"
      aria-labelledby="platform-heading"
      className="scroll-mt-24 bg-canvas py-page wide:py-20"
    >
      <div className={SHELL}>
        <div className="grid grid-cols-1 gap-x-8 gap-y-4 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <SectionLabel>The platform</SectionLabel>
            <h2
              id="platform-heading"
              className="mt-3 text-display font-semibold text-ink text-balance"
            >
              A complete lifecycle for institutional data
            </h2>
          </div>
          <div className="lg:col-span-5 lg:pt-9">
            <p className="text-body text-ink-secondary">
              Four things work against the backend today. The rest is designed and says so.
            </p>
          </div>
        </div>

        {CAPABILITY_GROUPS.map((group) => (
          <div key={group.label} className="mt-10 first:mt-8">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-line-strong pt-5">
              <h3
                className={`text-section font-semibold ${
                  group.planned ? "text-warning-ink" : "text-ink"
                }`}
              >
                {group.label}
              </h3>
              <p className="text-supporting text-ink-muted">{group.note}</p>
            </div>
            <CapabilityRows items={group.items} />
          </div>
        ))}
      </div>
    </section>
  );
}

/* --------------------------------------------------------------------------
 * Institutional use cases
 * ----------------------------------------------------------------------- */

/**
 * Sectors the product is shaped for — described from the requirement they put
 * on a lifecycle system, never as a customer story. No organisation named here
 * is or implies a deployment.
 */
const SECTORS: Array<{ title: string; pressure: string; answer: string }> = [
  {
    title: "Universities and colleges",
    pressure:
      "Decades of registrar, research and departmental storage, with retention periods set by statute and funding bodies rather than by convenience.",
    answer:
      "Sources are scanned into one inventory, each record carries a sensitivity level, and an asset's assessment names the policy version that applies to it.",
  },
  {
    title: "Healthcare providers",
    pressure:
      "Access to patient-adjacent records has to be provable after the fact, not merely assumed to have been correct.",
    answer:
      "Every request is authorized by the server against the institutions an account belongs to; the browser never decides what a user may see.",
  },
  {
    title: "Enterprises",
    pressure:
      "Merges, acquisitions and shared drives leave several systems holding overlapping personal data with no single owner.",
    answer:
      "An account sees only the records of its own organization, and a platform administrator can see across them.",
  },
  {
    title: "Public institutions and local government",
    pressure:
      "A disposal decision must carry a documented reason and the name of the person who made it.",
    answer:
      "Holds block a decision from being actioned, and the review queue records each decision with its actor and rationale.",
  },
];

function UseCases() {
  return (
    <section
      id="solutions"
      aria-labelledby="solutions-heading"
      className="scroll-mt-24 border-t border-line bg-surface py-page wide:py-20"
    >
      <div className={`${SHELL} grid grid-cols-1 gap-x-8 gap-y-page lg:grid-cols-12`}>
        <div className="lg:col-span-4">
          <SectionLabel>Who it is for</SectionLabel>
          <h2
            id="solutions-heading"
            className="mt-3 text-display font-semibold text-ink text-balance"
          >
            Built around the pressures institutions actually carry
          </h2>
          <p className="mt-4 text-supporting text-ink-secondary">
            DataDiet is designed for organisations that hold records on behalf of other people and
            can be asked, years later, to explain what they kept and why.
          </p>
          <p className="mt-4 text-supporting text-ink-muted">
            These are the sectors the product is shaped for. They are not customer references: no
            organisation named here is a DataDiet customer, and this page publishes no customer
            names, logos, testimonials, or deployment counts.
          </p>
        </div>

        <ul className="lg:col-span-8">
          {SECTORS.map((sector) => (
            <li key={sector.title} className="border-t border-line py-6 first:border-t-0 first:pt-0">
              <h3 className="text-title font-semibold text-ink">{sector.title}</h3>
              <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                <div>
                  <dt className="text-eyebrow font-semibold uppercase tracking-[0.06em] text-ink-muted">
                    The pressure
                  </dt>
                  <dd className="mt-1.5 text-supporting text-ink-secondary">{sector.pressure}</dd>
                </div>
                <div>
                  <dt className="text-eyebrow font-semibold uppercase tracking-[0.06em] text-ink-muted">
                    What DataDiet does
                  </dt>
                  <dd className="mt-1.5 text-supporting text-ink-secondary">{sector.answer}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------------------
 * Governance and trust
 * ----------------------------------------------------------------------- */

const TRUST_POINTS: Array<{ title: string; body: string; state?: string; tone?: Tone }> = [
  {
    title: "Privacy-conscious handling",
    body: "Discovery works from metadata: name, size, timestamps. The local-folder connector does not read file contents, does not follow symlinks, and can only be pointed at a root an operator approved server-side.",
  },
  {
    title: "Access limited to your organization",
    body: "An account belongs to institutions, and the backend resolves every request inside that membership. Roles grant documented permissions; the frontend only ever displays what the server already verified.",
  },
  {
    title: "Policy-driven retention",
    body: "Policies have versions, a version is activated deliberately, and an asset's assessment reports which version applied to it at the time.",
  },
  {
    title: "Auditable decisions",
    body: "Source, scan, classification, governance and account changes each write an append-only audit event in the same transaction as the change itself.",
  },
  {
    title: "Integrity verification for stored objects",
    body: "Designed in the archive-evidence architecture and asserted as a requirement of any future archiving run: no checksum is computed or verified today, because no object is stored today.",
    state: "Planned, not implemented",
    tone: "warning",
  },
];

function GovernanceTrust() {
  return (
    <section
      id="governance"
      aria-labelledby="governance-heading"
      className="scroll-mt-24 border-t border-line bg-canvas py-page wide:py-20"
    >
      <div className={`${SHELL} grid grid-cols-1 gap-x-8 gap-y-page lg:grid-cols-12`}>
        <div className="lg:col-span-5">
          <SectionLabel>Governance and trust</SectionLabel>
          <h2
            id="governance-heading"
            className="mt-3 text-display font-semibold text-ink text-balance"
          >
            Controls that hold up when someone asks
          </h2>
          <p className="mt-4 text-supporting text-ink-secondary">
            Governance is a set of mechanisms, not a badge. The list on the right is what the
            software enforces, what it plans to enforce, and what it does not claim.
          </p>

          <div className="mt-6 rounded-card border border-line bg-surface-sunken p-card-x">
            <h3 className="text-section font-semibold text-ink">What this page does not claim</h3>
            <p className="mt-2 text-supporting text-ink-secondary">
              DataDiet holds no certifications and asserts no regulatory compliance. No ISO 27001,
              SOC 2, GDPR adequacy, HIPAA or Cyber Essentials statement is made here, and none
              should be inferred from the word "compliance" anywhere on this page.
            </p>
            <p className="mt-2 text-supporting text-ink-secondary">
              Destructive actions are disabled by design. Archiving, restoration, moving, disposal
              and deletion do not run anywhere in the platform, so no workflow on this page can
              remove data.
            </p>
          </div>
        </div>

        <ul className="lg:col-span-7">
          {TRUST_POINTS.map((point, index) => (
            <li key={point.title} className="border-t border-line py-6 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                {/* Hanging indent: the numeral holds a column of its own, so a
                    title that wraps lines up under its first word. */}
                <h3 className="-indent-8 pl-8 text-section font-semibold text-ink">
                  <span className="inline-block w-8 text-eyebrow font-semibold tabular-nums text-ink-secondary">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  {point.title}
                </h3>
                {point.state ? <Badge tone={point.tone ?? "neutral"}>{point.state}</Badge> : null}
              </div>
              <p className="mt-2 pl-8 text-supporting text-ink-secondary">{point.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------------------
 * Customers: the account model, stated plainly
 * ----------------------------------------------------------------------- */

const ROLES: Array<{ role: string; body: string }> = [
  {
    role: "Viewer",
    body: "Reads inventory, governance, retention and source metadata within their own institution.",
  },
  {
    role: "Reviewer",
    body: "Adds the two review-workflow actions: assess an asset against policy and record a decision.",
  },
  {
    role: "Admin",
    body: "Adds write actions for retention, sources, assets and classification rules, still inside one institution.",
  },
  {
    role: "Platform admin",
    body: "A flag on the account, not a role. Selects which institution a request is scoped to and manages users.",
  },
];

function Customers() {
  return (
    <section
      id="customers"
      aria-labelledby="customers-heading"
      className="scroll-mt-24 border-t border-line bg-surface py-page wide:py-20"
    >
      <div className={`${SHELL} grid grid-cols-1 gap-x-8 gap-y-page lg:grid-cols-12`}>
        <div className="lg:col-span-5">
          <SectionLabel>Customers and accounts</SectionLabel>
          <h2
            id="customers-heading"
            className="mt-3 text-display font-semibold text-ink text-balance"
          >
            One institution, one scope, four kinds of account
          </h2>
          <p className="mt-4 text-supporting text-ink-secondary">
            A DataDiet account is a person's identity plus their memberships: the institutions they
            belong to and the role they hold in each. Permissions are derived from that role on the
            server and returned with the identity, so a session carries exactly its own scope.
          </p>
          <p className="mt-4 text-supporting text-ink-muted">
            We publish no customer names, logos, case studies, testimonials or usage metrics. This
            is a prototype deployment with no reference customers to name, and an invented logo wall
            would be worse than none.
          </p>
        </div>

        <div className="lg:col-span-7">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">
              The roles a DataDiet account can hold and what each one is granted
            </caption>
            <thead>
              <tr className="border-b border-line-strong">
                <th
                  scope="col"
                  className="py-3 pr-4 text-eyebrow font-semibold uppercase tracking-[0.06em] text-ink-muted"
                >
                  Role
                </th>
                <th
                  scope="col"
                  className="py-3 text-eyebrow font-semibold uppercase tracking-[0.06em] text-ink-muted"
                >
                  What it grants
                </th>
              </tr>
            </thead>
            <tbody>
              {ROLES.map((entry) => (
                <tr key={entry.role} className="border-b border-line">
                  <th scope="row" className="py-4 pr-4 align-top text-body font-semibold text-ink">
                    {entry.role}
                  </th>
                  <td className="py-4 align-top text-supporting text-ink-secondary">{entry.body}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-4 text-supporting text-ink-muted">
            The permission strings behind these roles are documented in the backend and listed in
            ADR-0014. Nothing on this page widens them.
          </p>
        </div>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------------------
 * Resources, company
 * ----------------------------------------------------------------------- */

const RESOURCES: Array<{ title: string; body: string; to?: string; isRoute?: boolean }> = [
  {
    title: "Sign in to the application",
    body: "The product itself is the best documentation. With an account, sign-in leads to the dashboard.",
    to: "/signin",
    isRoute: true,
  },
  {
    title: "Product areas behind sign-in",
    body: "Dashboard, Inventory, Sources, Scans, Risk Analysis, Classification, Retention Policies, Holds and Recommendations, plus the per-record screens. They need a signed-in account, so they are not linked from this public page.",
  },
  {
    title: "API reference",
    body: "A running deployment serves the FastAPI OpenAPI documentation at /docs on its own API origin. There is no separately hosted public reference from this build.",
  },
  {
    title: "Architecture and decision records",
    body: "The repository carries docs/architecture.md and docs/decisions.md, including ADR-0014 on identity and authorization and the archive-evidence design. They ship with the source and are not published as a website.",
  },
];

function Resources() {
  return (
    <section
      id="resources"
      aria-labelledby="resources-heading"
      className="scroll-mt-24 border-t border-line bg-canvas py-page wide:py-20"
    >
      <div className={SHELL}>
        <SectionLabel>Resources</SectionLabel>
        <h2
          id="resources-heading"
          className="mt-3 text-display font-semibold text-ink text-balance"
        >
          What you can read, and where it lives
        </h2>

        <ul className="mt-6 grid grid-cols-1 gap-x-page md:grid-cols-2">
          {RESOURCES.map((resource) => (
            <li key={resource.title} className="border-t border-line py-6">
              <h3 className="text-section font-semibold text-ink">{resource.title}</h3>
              <p className="mt-2 text-supporting text-ink-secondary">{resource.body}</p>
              {resource.isRoute ? (
                <Link
                  to={resource.to ?? "/signin"}
                  className="mt-3 inline-flex items-center gap-1 rounded-control text-meta font-medium text-accent-ink transition-colors hover:text-accent hover:underline"
                >
                  Go to sign in
                  <IconChevronRight className="h-3.5 w-3.5" />
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Company() {
  return (
    <section
      id="company"
      aria-labelledby="company-heading"
      className="scroll-mt-24 border-t border-line bg-surface py-page wide:py-20"
    >
      <div className={`${SHELL} grid grid-cols-1 gap-x-8 gap-y-6 lg:grid-cols-12`}>
        <div className="lg:col-span-5">
          <SectionLabel>Company</SectionLabel>
          <h2
            id="company-heading"
            className="mt-3 text-display font-semibold text-ink text-balance"
          >
            A prototype, described as one
          </h2>
          <p className="mt-4 text-supporting text-ink-secondary">
            DataDiet is maintained by the DataDiet team named in the API's own contact metadata.
            The deployment this page was served from is a prototype: identity and authorization are
            real and verified server-side, the lifecycle actions that would move or remove data are
            not implemented, and the page says so wherever it matters.
          </p>
        </div>

        <dl className="lg:col-span-7 lg:grid lg:grid-cols-2 lg:gap-x-page">
          {[
            {
              t: "Status",
              d: "Prototype. Discovery, classification proposals, retention policy administration, holds and the review queue work end to end against the backend. Archiving, restoration and disposal are designs, not features.",
            },
            {
              t: "Authorization model",
              d: "Documented in ADR-0014: the backend authorizes every request against the identity carried by the token. Frontend navigation is a convenience, never a permission check.",
            },
            {
              t: "Contact",
              d: "There is no published postal address, telephone number, or mailing list for this build, and no demo-request endpoint to post to. Access to a hosted instance is arranged with the team that operates it.",
            },
            {
              t: "Licence",
              d: "Proprietary, as stated in the API metadata. No public licence text is published from this deployment.",
            },
          ].map((item) => (
            <div key={item.t} className="border-t border-line py-5">
              <dt className="text-eyebrow font-semibold uppercase tracking-[0.06em] text-ink-muted">
                {item.t}
              </dt>
              <dd className="mt-1.5 text-supporting text-ink-secondary">{item.d}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------------------
 * Closing call to action
 * ----------------------------------------------------------------------- */

function ClosingCallToAction() {
  return (
    <section
      id="contact"
      aria-labelledby="contact-heading"
      tabIndex={-1}
      className="scroll-mt-24 border-t border-line-inverse bg-inverse py-page wide:py-20"
    >
      <div className={`${SHELL} grid grid-cols-1 gap-x-8 gap-y-6 lg:grid-cols-12`}>
        <div className="lg:col-span-7">
          {/* The one teal accent on this band, as the label of where to go next. */}
          <p className="text-eyebrow font-semibold uppercase tracking-[0.06em] text-accent-on-inverse">
            Get started
          </p>
          <h2
            id="contact-heading"
            className="mt-3 text-display font-semibold text-ink-inverse text-balance"
          >
            Bring clarity and control to your institutional data.
          </h2>
          <p className="mt-4 max-w-[38rem] text-body text-ink-inverse-muted">
            Sign in to see the inventory, policies and review queue running against a real backend.
            The lifecycle actions that would move or delete data are deliberately not enabled.
          </p>
          <div className="mt-7">
            <Link to="/signin" className={LINK_ON_INVERSE}>
              Explore DataDiet
              <IconChevronRight className="h-4 w-4" />
            </Link>
          </div>
        </div>

        <div className="lg:col-span-5 lg:pt-1">
          {/*
            The labelled note the "Request a demo" link resolves to. A demo
            request needs somewhere to go; this deployment has no such endpoint,
            so the page says what happens instead of pretending otherwise.
          */}
          <div className="rounded-card border border-line-inverse bg-inverse-raised p-card-x">
            <h3 className="text-section font-semibold text-ink-inverse">Requesting a demo</h3>
            <p className="mt-2 text-supporting text-ink-inverse-muted">
              This build collects nothing: there is no demo-request form, endpoint, or inbox behind
              the button above, and no personal data is submitted by reading this page. Access to a
              hosted instance is arranged directly with the DataDiet team operating it, and anyone
              who already has an account can use the sign-in page.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------------------
 * Footer
 * ----------------------------------------------------------------------- */

/**
 * Footer links are the quietest interactive text on the page: colour only on
 * hover, with the underline as the second signal so the state never depends on
 * hue alone.
 */
const FOOTER_LINK =
  "rounded-sm text-supporting text-ink-secondary transition-colors hover:text-accent-ink hover:underline";

function SiteFooter() {
  return (
    <footer className="border-t border-line bg-canvas">
      <div className={`${SHELL} py-page`}>
        <div className="grid grid-cols-1 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <div className="flex items-center gap-2.5">
              <BrandMark />
              <span className="text-body font-semibold text-ink">DataDiet</span>
            </div>
            <p className="mt-3 max-w-[28rem] text-supporting text-ink-secondary">
              Data lifecycle and privacy management for institutions: discover what you hold,
              classify it, decide how long it stays, and be able to explain the decision.
            </p>
          </div>

          <nav aria-label="Product">
            <h2 className="text-eyebrow font-semibold uppercase tracking-[0.06em] text-ink">
              Product
            </h2>
            <ul className="mt-4 space-y-2.5">
              {NAV_LINKS.slice(0, 2).map((link) => (
                <li key={link.href}>
                  <a
                    href={link.href}
                    className={FOOTER_LINK}
                  >
                    {link.label}
                  </a>
                </li>
              ))}
              <li>
                <a
                  href="#governance"
                  className={FOOTER_LINK}
                >
                  Governance
                </a>
              </li>
            </ul>
          </nav>

          <nav aria-label="Account and company">
            <h2 className="text-eyebrow font-semibold uppercase tracking-[0.06em] text-ink">
              Account
            </h2>
            <ul className="mt-4 space-y-2.5">
              <li>
                <Link
                  to="/signin"
                  className={FOOTER_LINK}
                >
                  Sign in
                </Link>
              </li>
              <li>
                <a
                  href="#contact"
                  className={FOOTER_LINK}
                >
                  Request a demo
                </a>
              </li>
              <li>
                <a
                  href="#company"
                  className={FOOTER_LINK}
                >
                  About this build
                </a>
              </li>
            </ul>
          </nav>
        </div>

        <div className="mt-10 border-t border-line pt-5">
          <p className="text-supporting text-ink-secondary">
            &copy; 2026 DataDiet. Prototype deployment; content is illustrative and shows no customer
            or production data.
          </p>
          <p className="mt-1.5 text-supporting text-ink-secondary">
            No destructive actions are enabled: archiving, restoration, and disposal are not
            implemented. No privacy policy, terms of service, or acceptable-use page is published
            from this build, so none is linked; the sections above state the handling this prototype
            actually performs.
          </p>
        </div>
      </div>
    </footer>
  );
}

/* --------------------------------------------------------------------------
 * Page
 * ----------------------------------------------------------------------- */

export default function Landing() {
  return (
    <div className="landing-page min-h-full bg-surface">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus:rounded-control focus:bg-surface focus:px-control-x focus:py-control-y focus:text-body focus:font-semibold focus:text-ink focus:shadow-raised"
      >
        Skip to content
      </a>

      <SiteHeader />

      <main id="main-content" tabIndex={-1}>
        <Hero />
        <PlatformOverview />
        <UseCases />
        <GovernanceTrust />
        <Customers />
        <Resources />
        <Company />
        <ClosingCallToAction />
      </main>

      <SiteFooter />
    </div>
  );
}
