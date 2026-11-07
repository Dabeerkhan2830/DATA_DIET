"""``CORS_ORIGINS`` must survive the flat-string environment of a deployed host.

App Service application settings can only carry plain strings, so the
comma-separated form documented in ``.env.example`` has to work when it arrives
from the environment or a ``.env`` file — not only when it is passed to the
constructor. Before ``NoDecode`` was applied to the field, pydantic-settings
JSON-decoded the list field inside its env/dotenv source, which runs before any
validator, and startup failed for ``CORS_ORIGINS=https://frontend.example``.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from pydantic import ValidationError

from app.core.config import Settings

ALL_KEYS = ("ENVIRONMENT", "DATABASE_URL", "CORS_ORIGINS")


@contextmanager
def clean_environment() -> Iterator[None]:
    """Build settings from the process environment only, never from a ``.env``."""
    saved = {key: os.environ.get(key) for key in ALL_KEYS}
    for key in ALL_KEYS:
        os.environ.pop(key, None)
    os.environ["ENVIRONMENT"] = "test"
    try:
        yield
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def _settings(**overrides: object) -> Settings:
    return Settings(_env_file=None, **overrides)


def test_default_is_the_vite_dev_server() -> None:
    with clean_environment():
        assert _settings().cors_origins == ["http://localhost:5173"]


def test_comma_separated_origins_from_environment() -> None:
    with clean_environment():
        os.environ["CORS_ORIGINS"] = (
            "https://datadiet.example.edu , http://localhost:5173,,"
        )
        assert _settings().cors_origins == [
            "https://datadiet.example.edu",
            "http://localhost:5173",
        ]


def test_single_origin_from_environment() -> None:
    """One origin has no comma but must not be rejected as "not JSON" either."""
    with clean_environment():
        os.environ["CORS_ORIGINS"] = "https://datadiet.example.edu"
        assert _settings().cors_origins == ["https://datadiet.example.edu"]


def test_json_array_still_supported() -> None:
    with clean_environment():
        os.environ["CORS_ORIGINS"] = '["https://a.example.edu", "https://b.example.edu"]'
        assert _settings().cors_origins == ["https://a.example.edu", "https://b.example.edu"]


def test_empty_value_means_no_allowed_origins() -> None:
    with clean_environment():
        os.environ["CORS_ORIGINS"] = ""
        assert _settings().cors_origins == []


def test_malformed_json_array_fails_instead_of_passing_junk() -> None:
    with clean_environment():
        os.environ["CORS_ORIGINS"] = "[https://not-json.example"
        with pytest.raises(ValidationError, match="valid JSON"):
            _settings()
