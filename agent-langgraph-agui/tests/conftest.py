"""Make harness imports independent of pytest's working directory and test order."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from harness_support import model_server  # noqa: E402,F401  (a fixture, registered for every test)
