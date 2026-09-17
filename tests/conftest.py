"""Shared pytest configuration for the template repo's own test suite.

Kept empty on purpose. Historical note for future archaeology: a
pytest-xdist hook-env isolation experiment (per-worker ``PRE_COMMIT_HOME``)
was tried here in 2026-09 to mitigate a pre-commit shared-store flake and
reverted — the suite mass-slowed (46s → 7m44s) with 48 failures. The flake
itself is gone for good: the template no longer ships pre-commit (lint runs
ruff directly; hygiene checks moved to the ``_hygiene.yml`` CI workflow).
"""
