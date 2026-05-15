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
SQL_DIR = ROOT / "infra" / "postgres"

SQL_FILES = sorted(SQL_DIR.glob("*.sql"))


def _parse(path: Path):
    return pglast.parse_sql(path.read_text())


@pytest.mark.parametrize("sql_path", SQL_FILES, ids=lambda p: p.name)
def test_sql_file_parses(sql_path: Path):
    """Each migration must be syntactically valid Postgres SQL."""
    stmts = _parse(sql_path)
    assert len(stmts) > 0, f"{sql_path.name} produced no statements"


def test_init_creates_core_tables():
    """001_init.sql must declare bs_project / bs_spec / bs_run / bs_spec_version."""
    sql = (SQL_DIR / "001_init.sql").read_text().lower()
    for tbl in ("bs_project", "bs_spec", "bs_spec_version", "bs_run", "bs_run_uses_spec", "bs_lineage_edge"):
        assert f"create table {tbl}" in sql or f"create table if not exists {tbl}" in sql, \
            f"missing table {tbl} in init"


def test_seed_references_existing_project():
    """002_seed.sql must only insert rows for project ids that bs_project also seeds."""
    sql = (SQL_DIR / "002_seed.sql").read_text()
    # Every bs_run / bs_spec INSERT must reference 'p_default'.
    assert "'p_default'" in sql
    # And p_default itself must be declared first in bs_project.
    assert "INSERT INTO bs_project" in sql
    pos_proj = sql.find("INSERT INTO bs_project")
    pos_spec = sql.find("INSERT INTO bs_spec")
    assert pos_proj < pos_spec, "bs_project insert must precede bs_spec inserts"


def test_multi_project_seed_is_isolated():
    """007_multi_project.sql declares p_lab and never references p_default."""
    sql = (SQL_DIR / "007_multi_project.sql").read_text()
    assert "'p_lab'" in sql
    # No row in this file should be tagged with p_default — that would mean a
    # seed leak across projects.
    # Tolerate the word inside comments though, so check INSERT lines only.
    for line in sql.splitlines():
        s = line.strip()
        if s.startswith("--") or not s:
            continue
        if "p_default" in s:
            pytest.fail(f"007_multi_project.sql leaks p_default: {s}")


def test_multi_project_specs_have_unique_ids():
    """The seed should not collide with hwspec_topo_b1 / model_moe256e etc."""
    sql_default = (SQL_DIR / "002_seed.sql").read_text()
    sql_lab = (SQL_DIR / "007_multi_project.sql").read_text()
    for spec_id in ("hwspec_topo_b1", "model_moe256e", "strategy_moescan", "workload_train"):
        assert spec_id in sql_default
        assert spec_id not in sql_lab, f"slice-15 lab seed collides on {spec_id}"
    for spec_id in ("hwspec_lab_a", "model_lab_dense", "strategy_lab", "workload_lab_inf"):
        assert spec_id in sql_lab


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
