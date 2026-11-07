"""Bind a verified identity-provider subject to a DataDiet account, offline.

Phase 6.0 (ADR-0025) moves sign-in to Clerk. The account a signed-in person
lands on is decided by one row in ``external_identities``: the pair
(``provider``, ``subject``) -> ``app_user``. **Email is never the key.** A
subject with no binding is refused at authentication time, so this script is the
normal way a person gets into the directory: the operator verifies who the Clerk
account belongs to, then records that fact here.

Why it is a script and not an endpoint: the same reason as
``scripts/bootstrap_admin.py`` (ADR-0014). A route that links an external
identity to a local account would let whoever can reach it walk into that
account's authorisations. Binding therefore requires database access, an
explicit operator identity, and produces an audit event.

What the script deliberately does *not* do:

* it never creates an ``app_user`` row. If the account does not exist yet, an
  administrator creates it first with ``bootstrap_admin.py`` -- so a bind can
  never invent a user, and a changed email address can never produce a second
  account for the same person;
* it never touches ``is_platform_admin``, never adds or changes a membership,
  and never reads Clerk metadata for authority. Roles stay DB-authoritative
  (``user_memberships``), so binding a subject grants exactly the access that
  account already had;
* it refuses to *move* a subject that is already bound to a different account
  unless ``--allow-rebind`` is passed, and it refuses to unbind unless
  ``--confirm`` is passed. Both are recorded with previous and resulting state.

Re-running ``bind`` for a subject that already maps to the same account is
idempotent: it refreshes the recorded ``last_email`` (a changed address must not
create a second identity) and writes no audit event when nothing changed.

Usage (from ``backend/``, against the same ``DATABASE_URL`` as the API)::

    ..\\.venv\\Scripts\\python.exe ..\\scripts\\bind_clerk_identity.py list
    ..\\.venv\\Scripts\\python.exe ..\\scripts\\bind_clerk_identity.py bind ^
        --subject user_2MrVerifiedSubject --email alice@example.org ^
        --actor "ops:your-name"
    ..\\.venv\\Scripts\\python.exe ..\\scripts\\bind_clerk_identity.py bind ^
        --subject user_2NewSubject --email alice@example.org ^
        --actor "ops:your-name" --allow-rebind
    ..\\.venv\\Scripts\\python.exe ..\\scripts\\bind_clerk_identity.py unbind ^
        --subject user_2NewSubject --actor "ops:your-name" --confirm
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

# Allow running as a plain script from backend/ or the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.core.auth import PROVIDER_CLERK  # noqa: E402
from app.db.models import AppUser, ExternalIdentity  # noqa: E402
from app.db.session import get_engine  # noqa: E402
from app.services.audit import record_event  # noqa: E402

#: ``AppUser.display_name`` / ``ExternalIdentity.bound_by`` column limits, kept in
#: sync with the models so an over-long operator name is refused before the write.
MAX_SUBJECT_LENGTH = 120
MAX_ACTOR_LENGTH = 40

_BIND_EVENT = "users.clerk_identity_bound"
_REBIND_EVENT = "users.clerk_identity_rebound"
_UNBIND_EVENT = "users.clerk_identity_unbound"
_LEGACY_DEFAULT_ACTOR = "offline_operator"


class BindingError(RuntimeError):
    """A safe, operator-facing refusal; nothing was changed."""


def validate_actor(value: str) -> str:
    """Require an explicit, meaningful operator identity for the audit trail."""
    actor = (value or "").strip()
    if not actor:
        raise BindingError("actor must identify the operator; it cannot be blank")
    if actor == _LEGACY_DEFAULT_ACTOR:
        raise BindingError(
            f"actor must identify the operator, not the legacy default {_LEGACY_DEFAULT_ACTOR!r}"
        )
    if len(actor) > MAX_ACTOR_LENGTH:
        raise BindingError(f"actor must be at most {MAX_ACTOR_LENGTH} characters")
    return actor


def normalise_subject(value: str) -> str:
    """Trim and length-check the provider subject; it is the identity key."""
    subject = (value or "").strip()
    if not subject:
        raise BindingError("subject must be the provider's stable user id, not blank")
    if "@" in subject:
        # A guard against the classic mistake of binding by email address, which
        # would make the directory key itself the mutable contact detail.
        raise BindingError(
            "subject must be the provider subject (for example 'user_2Mr...'), "
            "not an email address; email is never the identity key"
        )
    if len(subject) > MAX_SUBJECT_LENGTH:
        raise BindingError(f"subject must be at most {MAX_SUBJECT_LENGTH} characters")
    return subject


def _normalise_email(value: str) -> str:
    cleaned = (value or "").strip().lower()
    if "@" not in cleaned or cleaned.startswith("@") or cleaned.endswith("@"):
        raise argparse.ArgumentTypeError("email must look like an email address")
    return cleaned


def _validation_summary(exc: ValidationError) -> str:
    """Field-level configuration errors with input values and URLs omitted."""
    errors = exc.errors(include_input=False, include_url=False)
    parts: list[str] = []
    for error in errors:
        location = ".".join(str(part) for part in error.get("loc", ())) or "<root>"
        parts.append(f"{location}: {error.get('msg', 'invalid value')}")
    return "; ".join(parts)[:500]


def _safe_failure(exc: BaseException) -> str:
    """Return a concise failure description that cannot contain credentials."""
    if isinstance(exc, (BindingError, argparse.ArgumentTypeError)):
        return str(exc)
    if isinstance(exc, ValidationError):
        return f"configuration is invalid ({_validation_summary(exc)})"
    if isinstance(exc, SQLAlchemyError):
        return (
            f"database error ({type(exc).__name__}); check DATABASE_URL and "
            "database connectivity"
        )
    return f"unexpected error ({type(exc).__name__})"


def _account(db: Session, *, email: str | None, user_id: int | None) -> AppUser:
    """Resolve exactly one existing account; never create one."""
    if (email is None) == (user_id is None):
        raise BindingError("pass exactly one of --email or --user-id to name the account")
    if user_id is not None:
        user = db.get(AppUser, user_id)
        if user is None:
            raise BindingError(
                f"Account #{user_id} does not exist. Create it with "
                "scripts/bootstrap_admin.py before binding an identity."
            )
        return user
    assert email is not None
    user = db.execute(select(AppUser).where(AppUser.email == email)).scalar_one_or_none()
    if user is None:
        raise BindingError(
            f"No account with email {email} exists. This script never creates "
            "accounts: create it first with scripts/bootstrap_admin.py, then bind again."
        )
    return user


def _binding_for_subject(db: Session, subject: str) -> ExternalIdentity | None:
    return db.execute(
        select(ExternalIdentity).where(
            ExternalIdentity.provider == PROVIDER_CLERK,
            ExternalIdentity.external_subject == subject,
        )
    ).scalar_one_or_none()


def _describe(db: Session, user_id: int) -> dict[str, object]:
    user = db.get(AppUser, user_id)
    return {
        "exists": user is not None,
        "app_user_id": user_id,
        "is_platform_admin": bool(user.is_platform_admin) if user else None,
    }


def bind(
    db: Session,
    *,
    subject: str,
    actor: str,
    email: str | None = None,
    user_id: int | None = None,
    allow_rebind: bool = False,
) -> dict[str, object]:
    """Point ``subject`` at an existing account; return a result summary.

    Validation happens before the first write, and the row change plus its audit
    event commit together, so a crash cannot leave a binding without a record.
    """
    actor = validate_actor(actor)
    subject = normalise_subject(subject)
    user = _account(db, email=email, user_id=user_id)

    existing = _binding_for_subject(db, subject)
    if existing is not None and existing.app_user_id == user.id:
        refreshed = False
        if existing.last_email != user.email:
            existing.last_email = user.email
            refreshed = True
        if refreshed:
            db.commit()
        return {
            "action": "already_bound",
            "subject": subject,
            "app_user_id": user.id,
            "email": user.email,
            "changed": refreshed,
        }

    if existing is not None:
        if not allow_rebind:
            raise BindingError(
                f"Subject {subject!r} is already bound to account #"
                f"{existing.app_user_id}, not to account #{user.id}. Pass "
                "--allow-rebind to move it; no change was made."
            )
        previous_user_id = existing.app_user_id
        existing.app_user_id = user.id
        existing.last_email = user.email
        existing.bound_by = actor
        record_event(
            db,
            actor=actor,
            event_type=_REBIND_EVENT,
            entity_type="external_identity",
            entity_id=f"{PROVIDER_CLERK}:{subject}",
            payload={
                "action": "rebound",
                "provider": PROVIDER_CLERK,
                "external_subject": subject,
                "via": "offline_script",
                "previous": _describe(db, previous_user_id),
                "resulting": _describe(db, user.id),
            },
            commit=False,
        )
        db.commit()
        return {
            "action": "rebound",
            "subject": subject,
            "app_user_id": user.id,
            "previous_app_user_id": previous_user_id,
            "email": user.email,
        }

    db.add(
        ExternalIdentity(
            provider=PROVIDER_CLERK,
            external_subject=subject,
            app_user_id=user.id,
            last_email=user.email,
            bound_by=actor,
        )
    )
    record_event(
        db,
        actor=actor,
        event_type=_BIND_EVENT,
        entity_type="app_user",
        entity_id=user.id,
        payload={
            "action": "bound",
            "provider": PROVIDER_CLERK,
            "external_subject": subject,
            "email_at_bind_time": user.email,
            "via": "offline_script",
            "previous": {"bound": False},
            "resulting": _describe(db, user.id),
        },
        commit=False,
    )
    db.commit()
    return {
        "action": "bound",
        "subject": subject,
        "app_user_id": user.id,
        "email": user.email,
    }


def unbind(db: Session, *, subject: str, actor: str, confirm: bool) -> dict[str, object]:
    """Remove the binding for ``subject``; the account itself is left intact."""
    actor = validate_actor(actor)
    subject = normalise_subject(subject)
    if not confirm:
        raise BindingError(
            "Unbinding revokes this subject's ability to sign in. Pass --confirm "
            "once you have verified the operator intent; no change was made."
        )
    existing = _binding_for_subject(db, subject)
    if existing is None:
        return {"action": "not_bound", "subject": subject, "changed": False}

    previous = _describe(db, existing.app_user_id)
    db.delete(existing)
    record_event(
        db,
        actor=actor,
        event_type=_UNBIND_EVENT,
        entity_type="external_identity",
        entity_id=f"{PROVIDER_CLERK}:{subject}",
        payload={
            "action": "unbound",
            "provider": PROVIDER_CLERK,
            "external_subject": subject,
            "via": "offline_script",
            "previous": previous,
            "resulting": {"bound": False, "account_still_exists": True},
        },
        commit=False,
    )
    db.commit()
    return {"action": "unbound", "subject": subject, "app_user_id": previous["app_user_id"]}


def list_bindings(
    db: Session, *, subject: str | None = None, email: str | None = None
) -> list[dict[str, object]]:
    """Read-only inventory of who is bound to whom."""
    statement = select(ExternalIdentity, AppUser).where(
        ExternalIdentity.provider == PROVIDER_CLERK,
        ExternalIdentity.app_user_id == AppUser.id,
    )
    wanted_subject = normalise_subject(subject) if subject is not None else None
    wanted_email = email.strip().lower() if email is not None else None
    rows = []
    for identity, user in db.execute(statement).all():
        if wanted_subject is not None and identity.external_subject != wanted_subject:
            continue
        if wanted_email is not None and user.email != wanted_email:
            continue
        rows.append(
            {
                "subject": identity.external_subject,
                "app_user_id": user.id,
                "email": user.email,
                "display_name": user.display_name,
                "is_platform_admin": bool(user.is_platform_admin),
                "bound_by": identity.bound_by,
            }
        )
    return rows


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Bind, rebind, unbind or list Clerk identities (offline)."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    bind_parser = sub.add_parser("bind", help="point a provider subject at an existing account")
    bind_parser.add_argument("--subject", required=True, help="the provider's stable user id")
    bind_parser.add_argument("--email", type=_normalise_email, default=None)
    bind_parser.add_argument("--user-id", type=int, default=None)
    bind_parser.add_argument(
        "--actor",
        required=True,
        help="Required audit identity, for example 'ops:alice'.",
    )
    bind_parser.add_argument(
        "--allow-rebind",
        action="store_true",
        help="Explicitly move a subject that is already bound to another account.",
    )

    unbind_parser = sub.add_parser("unbind", help="remove a binding (the account survives)")
    unbind_parser.add_argument("--subject", required=True)
    unbind_parser.add_argument("--actor", required=True)
    unbind_parser.add_argument(
        "--confirm",
        action="store_true",
        help="Required: this revokes the subject's ability to sign in.",
    )

    list_parser = sub.add_parser("list", help="show current bindings (read-only)")
    list_parser.add_argument("--subject", default=None)
    list_parser.add_argument("--email", type=_normalise_email, default=None)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the CLI, returning a non-zero code on every failure."""
    args = _build_parser().parse_args(argv)
    try:
        # Build the engine explicitly so a misconfigured environment fails
        # before any change is attempted; the exception is sanitized below.
        engine = get_engine()
        factory = sessionmaker(bind=engine, expire_on_commit=False)

        with factory() as db:
            if args.command == "bind":
                result = bind(
                    db,
                    subject=args.subject,
                    actor=args.actor,
                    email=args.email,
                    user_id=args.user_id,
                    allow_rebind=args.allow_rebind,
                )
            elif args.command == "unbind":
                result = unbind(db, subject=args.subject, actor=args.actor, confirm=args.confirm)
            else:
                rows = list_bindings(db, subject=args.subject, email=args.email)
                for row in rows:
                    print(
                        f"{row['subject']} -> account #{row['app_user_id']} "
                        f"<{row['email']}> platform_admin={row['is_platform_admin']} "
                        f"(bound_by={row['bound_by']})"
                    )
                print(f"{len(rows)} binding(s). Authority comes from the directory, not here.")
                return 0
    except (BindingError, ValidationError, SQLAlchemyError) as exc:
        print(f"Identity binding failed: {_safe_failure(exc)}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - the CLI boundary must never echo a raw exception
        print(f"Identity binding failed: {_safe_failure(exc)}", file=sys.stderr)
        return 1

    action = result["action"]
    if action == "not_bound":
        print(f"Subject {result['subject']} has no binding; nothing was changed.")
    elif action == "already_bound":
        print(
            f"Subject {result['subject']} was already bound to account #"
            f"{result['app_user_id']} <{result['email']}>."
        )
    elif action == "rebound":
        print(
            f"Moved subject {result['subject']} from account #"
            f"{result['previous_app_user_id']} to account #{result['app_user_id']} "
            f"<{result['email']}>."
        )
    elif action == "unbound":
        print(
            f"Removed the binding for subject {result['subject']}. Account #"
            f"{result['app_user_id']} still exists with the same roles it had before."
        )
    else:
        print(
            f"Bound subject {result['subject']} to account #{result['app_user_id']} "
            f"<{result['email']}>. No privilege was granted by this change."
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
