#!/usr/bin/env python3
"""
Environment Validator
=====================

Validates that project environment variables are properly configured before
running the autonomous agent. This ensures the agent can actually test and
verify features by connecting to real services.

Key validations:
1. .env.local file exists in project directory
2. Required variables are present
3. Variables are not placeholder values
4. Optional: Attempt to pull from Vercel if missing
"""

import os
import re
import subprocess
from pathlib import Path
from typing import NamedTuple


class EnvValidationResult(NamedTuple):
    """Result of environment validation."""
    is_valid: bool
    env_file_exists: bool
    missing_vars: list[str]
    placeholder_vars: list[str]
    messages: list[str]


# Common placeholder patterns that indicate unconfigured variables
PLACEHOLDER_PATTERNS = [
    r'^placeholder$',
    r'^test[-_]?.*[-_]?placeholder$',
    r'^sk_test_placeholder$',
    r'^pk_test_placeholder$',
    r'^whsec_placeholder$',
    r'^re_placeholder$',
    r'^your[-_]',
    r'[-_]placeholder$',
    r'^xxx+$',
    r'^TODO',
    r'^CHANGEME',
    r'^INSERT[-_]',
]

# Required environment variables for a functioning app
# Grouped by service for better error messages
REQUIRED_ENV_VARS = {
    "database": ["DATABASE_URL"],
    "auth": ["AUTH_SECRET"],
    "auth_google": ["AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET"],
}

# Optional but recommended variables
RECOMMENDED_ENV_VARS = {
    "email": ["AUTH_RESEND_KEY", "RESEND_FROM_EMAIL"],
    "payments": ["STRIPE_SECRET_KEY", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"],
    "storage": ["BLOB_READ_WRITE_TOKEN"],
    "ai": ["GOOGLE_GENERATIVE_AI_API_KEY"],
}


def is_placeholder(value: str) -> bool:
    """Check if a value looks like a placeholder."""
    if not value:
        return True

    value_lower = value.lower().strip()

    for pattern in PLACEHOLDER_PATTERNS:
        if re.match(pattern, value_lower, re.IGNORECASE):
            return True

    return False


def parse_env_file(env_path: Path) -> dict[str, str]:
    """Parse a .env file and return key-value pairs."""
    env_vars = {}

    if not env_path.exists():
        return env_vars

    try:
        content = env_path.read_text(encoding='utf-8')
        for line in content.splitlines():
            line = line.strip()

            # Skip comments and empty lines
            if not line or line.startswith('#'):
                continue

            # Parse KEY=VALUE or KEY="VALUE"
            if '=' in line:
                key, _, value = line.partition('=')
                key = key.strip()
                value = value.strip()

                # Remove quotes if present
                if (value.startswith('"') and value.endswith('"')) or \
                   (value.startswith("'") and value.endswith("'")):
                    value = value[1:-1]

                env_vars[key] = value
    except Exception as e:
        print(f"Warning: Error parsing {env_path}: {e}")

    return env_vars


def validate_project_env(project_dir: Path, strict: bool = False) -> EnvValidationResult:
    """
    Validate environment variables for a project.

    Args:
        project_dir: Path to the project directory
        strict: If True, also check recommended variables

    Returns:
        EnvValidationResult with validation status and details
    """
    messages = []
    missing_vars = []
    placeholder_vars = []

    # Check for .env.local file
    env_file = project_dir / ".env.local"
    env_file_exists = env_file.exists()

    if not env_file_exists:
        # Also check for .env as fallback
        env_file = project_dir / ".env"
        env_file_exists = env_file.exists()

    if not env_file_exists:
        messages.append("No .env.local or .env file found in project directory")
        messages.append(f"Expected at: {project_dir / '.env.local'}")
        messages.append("")
        messages.append("To fix this, either:")
        messages.append("  1. Copy your local .env.local to the project")
        messages.append("  2. Run 'vercel env pull .env.local' in the project directory")
        messages.append("  3. Create .env.local with required variables")

        return EnvValidationResult(
            is_valid=False,
            env_file_exists=False,
            missing_vars=list(REQUIRED_ENV_VARS.keys()),
            placeholder_vars=[],
            messages=messages,
        )

    # Parse the env file
    env_vars = parse_env_file(env_file)

    # Check required variables
    for category, vars_list in REQUIRED_ENV_VARS.items():
        for var in vars_list:
            if var not in env_vars:
                missing_vars.append(var)
                messages.append(f"Missing required variable: {var} ({category})")
            elif is_placeholder(env_vars[var]):
                placeholder_vars.append(var)
                messages.append(f"Placeholder value detected: {var} ({category})")

    # Check recommended variables if strict mode
    if strict:
        for category, vars_list in RECOMMENDED_ENV_VARS.items():
            for var in vars_list:
                if var not in env_vars:
                    messages.append(f"Missing recommended variable: {var} ({category})")
                elif is_placeholder(env_vars[var]):
                    messages.append(f"Placeholder in recommended variable: {var} ({category})")

    # Determine if valid
    is_valid = len(missing_vars) == 0 and len(placeholder_vars) == 0

    if is_valid:
        messages.append("Environment validation passed")
    else:
        messages.append("")
        messages.append("To fix environment issues:")
        messages.append("  1. Run 'vercel link && vercel env pull .env.local' in project dir")
        messages.append("  2. Or copy .env.local from your local development environment")
        messages.append("  3. Or manually set the missing/placeholder variables")

    return EnvValidationResult(
        is_valid=is_valid,
        env_file_exists=env_file_exists,
        missing_vars=missing_vars,
        placeholder_vars=placeholder_vars,
        messages=messages,
    )


def attempt_vercel_env_pull(project_dir: Path) -> bool:
    """
    Attempt to pull environment variables from Vercel.

    Returns:
        True if successful, False otherwise
    """
    print("Attempting to pull environment variables from Vercel...")

    try:
        # Check if vercel CLI is available
        result = subprocess.run(
            ["vercel", "--version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            print("Vercel CLI not found or not configured")
            return False

        # Try to link if not already linked
        vercel_dir = project_dir / ".vercel"
        if not vercel_dir.exists():
            print("Project not linked to Vercel, attempting to link...")
            result = subprocess.run(
                ["vercel", "link", "--yes"],
                cwd=str(project_dir),
                capture_output=True,
                text=True,
                timeout=60,
            )
            if result.returncode != 0:
                print(f"Failed to link to Vercel: {result.stderr}")
                return False

        # Pull environment variables
        result = subprocess.run(
            ["vercel", "env", "pull", ".env.local", "--yes"],
            cwd=str(project_dir),
            capture_output=True,
            text=True,
            timeout=60,
        )

        if result.returncode == 0:
            print("Successfully pulled environment variables from Vercel")
            return True
        else:
            print(f"Failed to pull env vars: {result.stderr}")
            return False

    except subprocess.TimeoutExpired:
        print("Vercel command timed out")
        return False
    except FileNotFoundError:
        print("Vercel CLI not installed")
        return False
    except Exception as e:
        print(f"Error pulling from Vercel: {e}")
        return False


def ensure_project_env(
    project_dir: Path,
    auto_pull: bool = True,
    strict: bool = False,
    interactive: bool = True,
) -> bool:
    """
    Ensure project has valid environment variables.

    This is the main entry point for environment validation. It:
    1. Validates existing env vars
    2. Optionally attempts to pull from Vercel if missing
    3. Reports status and returns whether the project is ready

    Args:
        project_dir: Path to the project directory
        auto_pull: If True, attempt to pull from Vercel if env is missing/invalid
        strict: If True, also validate recommended variables
        interactive: If True, prompt user for confirmation on issues

    Returns:
        True if environment is valid (or user chose to proceed anyway)
    """
    print("\n" + "-" * 50)
    print("  Environment Validation")
    print("-" * 50)

    # Initial validation
    result = validate_project_env(project_dir, strict=strict)

    # If invalid and auto_pull enabled, try to fix
    if not result.is_valid and auto_pull:
        if attempt_vercel_env_pull(project_dir):
            # Re-validate after pull
            result = validate_project_env(project_dir, strict=strict)

    # Print validation messages
    for msg in result.messages:
        print(f"  {msg}")

    print("-" * 50)

    if result.is_valid:
        print("  Environment is properly configured")
        return True

    # Environment is not valid
    if interactive:
        print("\n  WARNING: Environment validation failed!")
        print("  The agent may not be able to verify features properly.")
        print()
        response = input("  Continue anyway? [y/N]: ").strip().lower()
        return response == 'y'
    else:
        print("\n  ERROR: Environment validation failed!")
        print("  Fix the issues above before running the agent.")
        return False


if __name__ == "__main__":
    # Test the validator
    import sys

    if len(sys.argv) > 1:
        project_path = Path(sys.argv[1])
    else:
        project_path = Path.cwd()

    print(f"Validating environment for: {project_path}")
    result = ensure_project_env(project_path, auto_pull=False, interactive=False)
    sys.exit(0 if result else 1)
