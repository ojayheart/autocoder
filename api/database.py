"""
Database Models and Connection
==============================

SQLite database schema for feature and test finding storage using SQLAlchemy.
"""

from datetime import datetime
from pathlib import Path
from typing import Optional

from sqlalchemy import Boolean, Column, DateTime, Integer, String, Text, create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session
from sqlalchemy.types import JSON

Base = declarative_base()


class TestFinding(Base):
    """Test finding model representing an issue discovered by the tester agent."""

    __tablename__ = "test_findings"

    id = Column(Integer, primary_key=True, index=True)
    severity = Column(String(20), nullable=False, index=True)  # critical, high, medium, low
    category = Column(String(50), nullable=False, index=True)  # functional, ux, edge-case, security, accessibility
    title = Column(String(255), nullable=False)
    description = Column(Text, nullable=False)
    steps_to_reproduce = Column(JSON, nullable=False)  # List of steps
    expected_behavior = Column(Text, nullable=True)
    actual_behavior = Column(Text, nullable=True)
    screenshot_path = Column(String(500), nullable=True)  # Optional screenshot
    url = Column(String(500), nullable=True)  # URL where issue was found
    related_feature_id = Column(Integer, nullable=True, index=True)  # Link to feature if applicable
    status = Column(String(20), nullable=False, default="open", index=True)  # open, in_progress, fixed, wont_fix
    suggested_fix = Column(Text, nullable=True)  # Optional suggestion from tester
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=True, onupdate=datetime.utcnow)

    def to_dict(self) -> dict:
        """Convert test finding to dictionary for JSON serialization."""
        return {
            "id": self.id,
            "severity": self.severity,
            "category": self.category,
            "title": self.title,
            "description": self.description,
            "steps_to_reproduce": self.steps_to_reproduce,
            "expected_behavior": self.expected_behavior,
            "actual_behavior": self.actual_behavior,
            "screenshot_path": self.screenshot_path,
            "url": self.url,
            "related_feature_id": self.related_feature_id,
            "status": self.status,
            "suggested_fix": self.suggested_fix,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class Feature(Base):
    """Feature model representing a test case/feature to implement."""

    __tablename__ = "features"

    id = Column(Integer, primary_key=True, index=True)
    priority = Column(Integer, nullable=False, default=999, index=True)
    category = Column(String(100), nullable=False)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=False)
    steps = Column(JSON, nullable=False)  # Stored as JSON array
    passes = Column(Boolean, default=False, index=True)
    in_progress = Column(Boolean, default=False, index=True)

    def to_dict(self) -> dict:
        """Convert feature to dictionary for JSON serialization."""
        return {
            "id": self.id,
            "priority": self.priority,
            "category": self.category,
            "name": self.name,
            "description": self.description,
            "steps": self.steps,
            "passes": self.passes,
            "in_progress": self.in_progress,
        }


def get_database_path(project_dir: Path) -> Path:
    """Return the path to the SQLite database for a project."""
    return project_dir / "features.db"


def get_database_url(project_dir: Path) -> str:
    """Return the SQLAlchemy database URL for a project.

    Uses POSIX-style paths (forward slashes) for cross-platform compatibility.
    """
    db_path = get_database_path(project_dir)
    return f"sqlite:///{db_path.as_posix()}"


def _migrate_add_in_progress_column(engine) -> None:
    """Add in_progress column to existing databases that don't have it."""
    from sqlalchemy import text

    with engine.connect() as conn:
        # Check if column exists
        result = conn.execute(text("PRAGMA table_info(features)"))
        columns = [row[1] for row in result.fetchall()]

        if "in_progress" not in columns:
            # Add the column with default value
            conn.execute(text("ALTER TABLE features ADD COLUMN in_progress BOOLEAN DEFAULT 0"))
            conn.commit()


def create_database(project_dir: Path) -> tuple:
    """
    Create database and return engine + session maker.

    Args:
        project_dir: Directory containing the project

    Returns:
        Tuple of (engine, SessionLocal)
    """
    db_url = get_database_url(project_dir)
    engine = create_engine(db_url, connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)

    # Migrate existing databases to add in_progress column
    _migrate_add_in_progress_column(engine)

    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    return engine, SessionLocal


# Global session maker - will be set when server starts
_session_maker: Optional[sessionmaker] = None


def set_session_maker(session_maker: sessionmaker) -> None:
    """Set the global session maker."""
    global _session_maker
    _session_maker = session_maker


def get_db() -> Session:
    """
    Dependency for FastAPI to get database session.

    Yields a database session and ensures it's closed after use.
    """
    if _session_maker is None:
        raise RuntimeError("Database not initialized. Call set_session_maker first.")

    db = _session_maker()
    try:
        yield db
    finally:
        db.close()
