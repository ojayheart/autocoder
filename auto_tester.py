#!/usr/bin/env python3
"""
Auto Tester Agent
==================

An intelligent testing agent that explores applications, finds bugs,
and reports issues. Unlike scripted e2e tests, this agent can:

- Understand context and navigate intelligently
- Evaluate UX quality, not just functionality
- Find edge cases developers missed
- Report issues with clear reproduction steps

Example Usage:
    # Using absolute path directly
    python auto_tester.py --project-dir C:/Projects/my-app

    # Using registered project name
    python auto_tester.py --project-dir my-app

    # Limit iterations for a quick test pass
    python auto_tester.py --project-dir my-app --max-iterations 3
"""

import argparse
import asyncio
import os
from pathlib import Path

from dotenv import load_dotenv

# Load environment variables from .env file (if it exists)
load_dotenv()

from registry import get_project_path

# Configuration
DEFAULT_MODEL = "claude-opus-4-5-20251101"


def parse_args() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Auto Tester Agent - Intelligent application testing",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Use absolute path directly
  python auto_tester.py --project-dir C:/Projects/my-app

  # Use registered project name
  python auto_tester.py --project-dir my-app

  # Quick test pass (limited iterations)
  python auto_tester.py --project-dir my-app --max-iterations 3

  # Use a specific model
  python auto_tester.py --project-dir my-app --model claude-sonnet-4-5-20250929

Authentication:
  Uses Claude CLI credentials from ~/.claude/.credentials.json
  Run 'claude login' to authenticate
        """,
    )

    parser.add_argument(
        "--project-dir",
        type=str,
        required=True,
        help="Project directory path (absolute) or registered project name",
    )

    parser.add_argument(
        "--max-iterations",
        type=int,
        default=None,
        help="Maximum number of agent iterations (default: unlimited)",
    )

    parser.add_argument(
        "--model",
        type=str,
        default=DEFAULT_MODEL,
        help=f"Claude model to use (default: {DEFAULT_MODEL})",
    )

    return parser.parse_args()


async def run_tester_agent(
    project_dir: Path,
    model: str,
    max_iterations: int | None = None,
) -> None:
    """
    Run the auto tester agent loop.

    Args:
        project_dir: Directory for the project
        model: Claude model to use
        max_iterations: Maximum number of iterations (None for unlimited)
    """
    # Import here to avoid circular imports
    from client import create_tester_client
    from agent import run_agent_session
    from prompts import load_prompt

    print("\n" + "=" * 70)
    print("  AUTO TESTER AGENT")
    print("=" * 70)
    print(f"\nProject directory: {project_dir}")
    print(f"Model: {model}")
    if max_iterations:
        print(f"Max iterations: {max_iterations}")
    else:
        print("Max iterations: Unlimited (will run until completion)")
    print()

    # Create project directory if it doesn't exist
    project_dir.mkdir(parents=True, exist_ok=True)

    # Load tester prompt
    prompt = load_prompt("tester_prompt", project_dir)

    # Main loop
    iteration = 0
    AUTO_CONTINUE_DELAY_SECONDS = 3

    while True:
        iteration += 1

        # Check max iterations
        if max_iterations and iteration > max_iterations:
            print(f"\nReached max iterations ({max_iterations})")
            break

        # Print session header
        print("\n" + "=" * 70)
        print(f"  TESTER SESSION {iteration}")
        print("=" * 70 + "\n")

        # Create client (fresh context)
        client = create_tester_client(project_dir, model)

        # Run session with async context manager
        async with client:
            status, response = await run_agent_session(client, prompt, project_dir)

        # Handle status
        if status == "continue":
            print(f"\nTester will auto-continue in {AUTO_CONTINUE_DELAY_SECONDS}s...")
            await asyncio.sleep(AUTO_CONTINUE_DELAY_SECONDS)

        elif status == "error":
            print("\nSession encountered an error")
            print("Will retry with a fresh session...")
            await asyncio.sleep(AUTO_CONTINUE_DELAY_SECONDS)

        # Small delay between sessions
        if max_iterations is None or iteration < max_iterations:
            print("\nPreparing next session...\n")
            await asyncio.sleep(1)

    # Final summary
    print("\n" + "=" * 70)
    print("  TESTING SESSION COMPLETE")
    print("=" * 70)
    print(f"\nProject directory: {project_dir}")
    print("\nTo view findings, check the test_findings.db database")
    print("or run the tester again to continue testing.")

    print("\nDone!")


def main() -> None:
    """Main entry point."""
    args = parse_args()

    # Resolve project directory
    project_dir_input = args.project_dir
    project_dir = Path(project_dir_input)

    if project_dir.is_absolute():
        if not project_dir.exists():
            print(f"Error: Project directory does not exist: {project_dir}")
            return
    else:
        # Treat as a project name - look up from registry
        registered_path = get_project_path(project_dir_input)
        if registered_path:
            project_dir = registered_path
        else:
            print(f"Error: Project '{project_dir_input}' not found in registry")
            print("Use an absolute path or register the project first.")
            return

    try:
        asyncio.run(
            run_tester_agent(
                project_dir=project_dir,
                model=args.model,
                max_iterations=args.max_iterations,
            )
        )
    except KeyboardInterrupt:
        print("\n\nInterrupted by user")
        print("To resume, run the same command again")
    except Exception as e:
        print(f"\nFatal error: {e}")
        raise


if __name__ == "__main__":
    main()
