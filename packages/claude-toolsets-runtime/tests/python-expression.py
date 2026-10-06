"""Exercise the actual Python bridge without importing optional SDK dependencies."""

import importlib.util
import json
import sys
from pathlib import Path

path = Path(__file__).resolve().parents[2] / "claude-toolsets-python/e2b_claude_toolsets/_scripts.py"
spec = importlib.util.spec_from_file_location("runtime_bridge", path)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
request = json.load(sys.stdin)
print(module.RUNTIME_SOURCE if request.get("install") else module.expression(request["operation"], request["args"]))
