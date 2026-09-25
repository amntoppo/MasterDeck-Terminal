import os
import sys

_here = os.path.dirname(os.path.abspath(__file__))
# This checkout's lib/ first, whatever PYTHONPATH says (an installed copy must not shadow it).
sys.path.insert(0, os.path.join(os.path.dirname(_here), "lib"))
# Tests run against a fixed, fictional config (org "acme", issue repo "tracker").
os.environ["MASTER_CONFIG"] = os.path.join(_here, "config.json")
