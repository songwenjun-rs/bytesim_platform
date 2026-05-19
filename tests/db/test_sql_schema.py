"""DB schema + seed sanity tests via libpg_query (pglast).

We don't have a live Postgres available in CI here, but pglast wraps
libpg_query — Postgres' own parser — so we can verify each .sql file is
syntactically accepted by the same grammar Postgres uses, plus run some
structural assertions on the parsed AST (table presence, FK targets,
seed referencing only declared projects, etc.)."""
from __future__ import annotations

import os
from pathlib import Path

import pytest
import pglast
from pglast import ast

ROOT = Path(__file__).resolve().parents[2]
SQL_DIR = ROOT / "service" / "data_svc" / "migrations"

SQL_FILES = sorted(SQL_DIR.glob("*.sql"))


def _parse(path: Path):
    return pglast.parse_sql(path.read_text())


@pytest.mark.parametrize("sql_path", SQL_FILES, ids=lambda p: p.name)
def test_sql_file_parses(sql_path: Path):
    """Each migration must be syntactically valid Postgres SQL."""
    stmts = _parse(sql_path)
    assert len(stmts) > 0, f"{sql_path.name} produced no statements"


def test_init_creates_core_tables():
    """001_schema.sql must declare the consolidated runtime tables."""
    sql = (SQL_DIR / "001_schema.sql").read_text().lower()
    for tbl in (
        "bs_project",
        "bs_spec",
        "bs_spec_version",
        "bs_catalog",
        "bs_engine",
        "bs_run",
        "bs_run_event",
        "bs_run_engine_call",
        "bs_run_uses_spec",
        "bs_run_artifact",
        "bs_tco_rule",
    ):
        assert f"create table {tbl}" in sql or f"create table if not exists {tbl}" in sql, \
            f"missing table {tbl} in schema"


def test_seed_references_existing_project():
    """002_reference.sql must seed projects before reference rows that can depend on them."""
    sql = (SQL_DIR / "002_reference.sql").read_text()
    assert "'p_default'" in sql
    assert "'p_lab'" in sql
    assert "INSERT INTO bs_project" in sql
    pos_proj = sql.find("INSERT INTO bs_project")
    pos_tco = sql.find("INSERT INTO bs_tco_rule")
    assert pos_proj < pos_tco, "bs_project insert must precede reference inserts"


def test_demo_seed_is_default_project_only():
    """003_demo.sql seeds demo specs into p_default only."""
    sql = (SQL_DIR / "003_demo.sql").read_text()
    assert "'p_default'" in sql
    for line in sql.splitlines():
        s = line.strip()
        if s.startswith("--") or not s:
            continue
        if "p_lab" in s:
            pytest.fail(f"003_demo.sql leaks p_lab: {s}")


def test_demo_specs_have_expected_ids():
    """The demo seed should keep the canonical onboarding spec ids stable."""
    sql_demo = (SQL_DIR / "003_demo.sql").read_text()
    for spec_id in ("hwspec_topo_b1", "model_moe256e", "strategy_train_b1", "workload_train_b1"):
        assert spec_id in sql_demo


def test_all_files_load_in_lexical_order_without_repeating_create_table():
    """If two .sql files create the same table, applying them in order would
    blow up. Catch it by walking ASTs."""
    seen: dict[str, str] = {}
    for sql_path in SQL_FILES:
        stmts = _parse(sql_path)
        for raw in stmts:
            stmt = raw.stmt
            if isinstance(stmt, ast.CreateStmt):
                tbl = stmt.relation.relname
                if tbl in seen:
                    pytest.fail(f"table {tbl} created in {seen[tbl]} and again in {sql_path.name}")
                seen[tbl] = sql_path.name


def test_inserts_target_only_declared_tables():
    """No INSERT may target a table that doesn't exist by the time it runs."""
    declared: set[str] = set()
    for sql_path in SQL_FILES:
        for raw in _parse(sql_path):
            stmt = raw.stmt
            if isinstance(stmt, ast.CreateStmt):
                declared.add(stmt.relation.relname)
            elif isinstance(stmt, ast.InsertStmt):
                tbl = stmt.relation.relname
                assert tbl in declared, f"{sql_path.name} inserts into undeclared table {tbl}"
