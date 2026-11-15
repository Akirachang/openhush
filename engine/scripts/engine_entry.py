"""Entry point for the frozen engine binary bundled inside OpenHush.app."""
import sys

from openhush_engine.server import main

if __name__ == "__main__":
    sys.exit(main())
