#!/usr/bin/env python3
"""
MCP Server for Test Finding Management
=======================================

Provides tools for the auto-tester agent to report and manage test findings.

Tools:
- finding_report: Report a new issue found during testing
- finding_get_stats: Get test finding statistics
- finding_list: List findings with optional filtering
- finding_update_status: Update finding status
- feature_list_for_testing: Get all features to test against
- coverage_mark_tested: Mark a feature as tested
- coverage_get_stats: Get test coverage statistics
"""

import json
import os
import sys
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Annotated, Optional

from mcp.server.fastmcp import FastMCP
from pydantic import Field
from sqlalchemy.sql.expression import func

# Add parent directory to path so we can import from api module
sys.path.insert(0, str(Path(__file__).parent.parent))

from api.database import Feature, TestFinding, Base, create_database

# Configuration from environment
PROJECT_DIR = Path(os.environ.get("PROJECT_DIR", ".")).resolve()

# Global database session maker (initialized on startup)
_session_maker = None
_engine = None


def get_test_findings_db_path(project_dir: Path) -> Path:
    """Return the path to the test findings database."""
    return project_dir / "test_findings.db"


def get_test_findings_db_url(project_dir: Path) -> str:
    """Return the SQLAlchemy database URL for test findings."""
    db_path = get_test_findings_db_path(project_dir)
    return f"sqlite:///{db_path.as_posix()}"


def create_test_findings_database(project_dir: Path) -> tuple:
    """Create test findings database and return engine + session maker."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    db_url = get_test_findings_db_url(project_dir)
    engine = create_engine(db_url, connect_args={"check_same_thread": False})

    # Create only the TestFinding table in this database
    TestFinding.__table__.create(bind=engine, checkfirst=True)

    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    return engine, SessionLocal


@asynccontextmanager
async def server_lifespan(server: FastMCP):
    """Initialize database on startup, cleanup on shutdown."""
    global _session_maker, _engine

    # Create project directory if it doesn't exist
    PROJECT_DIR.mkdir(parents=True, exist_ok=True)

    # Initialize test findings database
    _engine, _session_maker = create_test_findings_database(PROJECT_DIR)

    yield

    # Cleanup
    if _engine:
        _engine.dispose()


# Initialize the MCP server
mcp = FastMCP("tester", lifespan=server_lifespan)


def get_session():
    """Get a new database session."""
    if _session_maker is None:
        raise RuntimeError("Database not initialized")
    return _session_maker()


def get_features_session():
    """Get a session for the features database (read-only for tester)."""
    _, session_maker = create_database(PROJECT_DIR)
    return session_maker()


# =============================================================================
# Test Finding Tools
# =============================================================================

@mcp.tool()
def finding_report(
    severity: Annotated[str, Field(description="Issue severity: critical, high, medium, or low")],
    category: Annotated[str, Field(description="Issue category: functional, ux, edge-case, security, or accessibility")],
    title: Annotated[str, Field(description="Brief title describing the issue")],
    description: Annotated[str, Field(description="Detailed description of the issue")],
    steps_to_reproduce: Annotated[list[str], Field(description="List of steps to reproduce the issue")],
    expected_behavior: Annotated[Optional[str], Field(description="What should have happened")] = None,
    actual_behavior: Annotated[Optional[str], Field(description="What actually happened")] = None,
    url: Annotated[Optional[str], Field(description="URL where the issue was found")] = None,
    related_feature_id: Annotated[Optional[int], Field(description="ID of related feature if applicable")] = None,
    suggested_fix: Annotated[Optional[str], Field(description="Optional suggestion for how to fix")] = None,
    screenshot_path: Annotated[Optional[str], Field(description="Path to screenshot if captured")] = None,
) -> str:
    """Report a new issue found during testing.

    Use this to log bugs, UX problems, edge case failures, security issues,
    or accessibility problems discovered while testing the application.

    Severity levels:
    - critical: App crashes, data loss, security vulnerabilities
    - high: Major feature broken, significant UX issues
    - medium: Minor bugs, confusing UX, missing feedback
    - low: Cosmetic issues, minor improvements

    Categories:
    - functional: Feature doesn't work as specified
    - ux: Confusing interface, unclear feedback, poor flow
    - edge-case: Fails with unusual inputs or scenarios
    - security: Potential security vulnerability
    - accessibility: Accessibility issues (keyboard nav, screen readers, etc.)

    Returns:
        JSON with the created finding details
    """
    # Validate severity
    valid_severities = ["critical", "high", "medium", "low"]
    if severity.lower() not in valid_severities:
        return json.dumps({"error": f"Invalid severity. Must be one of: {valid_severities}"})

    # Validate category
    valid_categories = ["functional", "ux", "edge-case", "security", "accessibility"]
    if category.lower() not in valid_categories:
        return json.dumps({"error": f"Invalid category. Must be one of: {valid_categories}"})

    session = get_session()
    try:
        finding = TestFinding(
            severity=severity.lower(),
            category=category.lower(),
            title=title,
            description=description,
            steps_to_reproduce=steps_to_reproduce,
            expected_behavior=expected_behavior,
            actual_behavior=actual_behavior,
            url=url,
            related_feature_id=related_feature_id,
            suggested_fix=suggested_fix,
            screenshot_path=screenshot_path,
            status="open",
        )
        session.add(finding)
        session.commit()
        session.refresh(finding)

        return json.dumps({
            "message": f"Finding #{finding.id} reported successfully",
            "finding": finding.to_dict()
        }, indent=2)
    except Exception as e:
        session.rollback()
        return json.dumps({"error": str(e)})
    finally:
        session.close()


@mcp.tool()
def finding_get_stats() -> str:
    """Get statistics about test findings.

    Returns counts by severity and status, plus overall totals.
    Use this to understand the current state of testing.

    Returns:
        JSON with finding statistics
    """
    session = get_session()
    try:
        total = session.query(TestFinding).count()

        # Count by severity
        by_severity = {}
        for sev in ["critical", "high", "medium", "low"]:
            by_severity[sev] = session.query(TestFinding).filter(
                TestFinding.severity == sev
            ).count()

        # Count by status
        by_status = {}
        for status in ["open", "in_progress", "fixed", "wont_fix"]:
            by_status[status] = session.query(TestFinding).filter(
                TestFinding.status == status
            ).count()

        # Count by category
        by_category = {}
        for cat in ["functional", "ux", "edge-case", "security", "accessibility"]:
            by_category[cat] = session.query(TestFinding).filter(
                TestFinding.category == cat
            ).count()

        return json.dumps({
            "total": total,
            "by_severity": by_severity,
            "by_status": by_status,
            "by_category": by_category,
            "open_critical": session.query(TestFinding).filter(
                TestFinding.severity == "critical",
                TestFinding.status == "open"
            ).count(),
        }, indent=2)
    finally:
        session.close()


@mcp.tool()
def finding_list(
    status: Annotated[Optional[str], Field(description="Filter by status: open, in_progress, fixed, wont_fix")] = None,
    severity: Annotated[Optional[str], Field(description="Filter by severity: critical, high, medium, low")] = None,
    category: Annotated[Optional[str], Field(description="Filter by category")] = None,
    limit: Annotated[int, Field(default=20, ge=1, le=100, description="Max findings to return")] = 20,
) -> str:
    """List test findings with optional filtering.

    Returns findings sorted by severity (critical first) then by creation date.

    Args:
        status: Optional status filter
        severity: Optional severity filter
        category: Optional category filter
        limit: Maximum number of findings to return (1-100)

    Returns:
        JSON with list of findings
    """
    session = get_session()
    try:
        query = session.query(TestFinding)

        if status:
            query = query.filter(TestFinding.status == status.lower())
        if severity:
            query = query.filter(TestFinding.severity == severity.lower())
        if category:
            query = query.filter(TestFinding.category == category.lower())

        # Sort by severity (critical=1, high=2, medium=3, low=4) then by date
        severity_order = {
            "critical": 1,
            "high": 2,
            "medium": 3,
            "low": 4
        }
        findings = query.order_by(TestFinding.created_at.desc()).limit(limit).all()

        # Sort in Python since SQLite doesn't support CASE easily
        findings.sort(key=lambda f: (severity_order.get(f.severity, 5), f.created_at), reverse=False)

        return json.dumps({
            "count": len(findings),
            "findings": [f.to_dict() for f in findings]
        }, indent=2)
    finally:
        session.close()


@mcp.tool()
def finding_update_status(
    finding_id: Annotated[int, Field(description="ID of the finding to update", ge=1)],
    status: Annotated[str, Field(description="New status: open, in_progress, fixed, wont_fix")],
) -> str:
    """Update the status of a test finding.

    Use this when a finding has been addressed or is being worked on.

    Args:
        finding_id: The ID of the finding to update
        status: The new status

    Returns:
        JSON with the updated finding
    """
    valid_statuses = ["open", "in_progress", "fixed", "wont_fix"]
    if status.lower() not in valid_statuses:
        return json.dumps({"error": f"Invalid status. Must be one of: {valid_statuses}"})

    session = get_session()
    try:
        finding = session.query(TestFinding).filter(TestFinding.id == finding_id).first()

        if finding is None:
            return json.dumps({"error": f"Finding with ID {finding_id} not found"})

        finding.status = status.lower()
        session.commit()
        session.refresh(finding)

        return json.dumps({
            "message": f"Finding #{finding_id} status updated to {status}",
            "finding": finding.to_dict()
        }, indent=2)
    finally:
        session.close()


# =============================================================================
# Feature/Coverage Tools (read from features.db)
# =============================================================================

@mcp.tool()
def feature_list_for_testing(
    include_passing: Annotated[bool, Field(description="Include features marked as passing")] = True,
) -> str:
    """Get list of features to test against.

    Returns all features from the feature database so the tester can verify
    each feature works correctly.

    Args:
        include_passing: Whether to include features already marked as passing

    Returns:
        JSON with list of features
    """
    session = get_features_session()
    try:
        query = session.query(Feature)
        if not include_passing:
            query = query.filter(Feature.passes == False)

        features = query.order_by(Feature.priority.asc()).all()

        return json.dumps({
            "count": len(features),
            "features": [f.to_dict() for f in features]
        }, indent=2)
    finally:
        session.close()


@mcp.tool()
def feature_get_by_id(
    feature_id: Annotated[int, Field(description="ID of the feature to get", ge=1)],
) -> str:
    """Get a specific feature by ID.

    Use this to get full details of a feature you want to test.

    Args:
        feature_id: The ID of the feature

    Returns:
        JSON with feature details
    """
    session = get_features_session()
    try:
        feature = session.query(Feature).filter(Feature.id == feature_id).first()

        if feature is None:
            return json.dumps({"error": f"Feature with ID {feature_id} not found"})

        return json.dumps(feature.to_dict(), indent=2)
    finally:
        session.close()


@mcp.tool()
def coverage_get_stats() -> str:
    """Get test coverage statistics.

    Returns statistics about how many features have been tested,
    how many have associated findings, etc.

    Returns:
        JSON with coverage statistics
    """
    features_session = get_features_session()
    findings_session = get_session()
    try:
        total_features = features_session.query(Feature).count()
        passing_features = features_session.query(Feature).filter(Feature.passes == True).count()

        # Get features with findings
        feature_ids_with_findings = findings_session.query(
            TestFinding.related_feature_id
        ).filter(
            TestFinding.related_feature_id.isnot(None)
        ).distinct().all()
        features_with_findings = len(feature_ids_with_findings)

        # Get total findings count
        total_findings = findings_session.query(TestFinding).count()
        open_findings = findings_session.query(TestFinding).filter(
            TestFinding.status == "open"
        ).count()

        return json.dumps({
            "total_features": total_features,
            "passing_features": passing_features,
            "features_with_findings": features_with_findings,
            "total_findings": total_findings,
            "open_findings": open_findings,
            "coverage_percentage": round((passing_features / total_features) * 100, 1) if total_features > 0 else 0,
        }, indent=2)
    finally:
        features_session.close()
        findings_session.close()


if __name__ == "__main__":
    mcp.run()
