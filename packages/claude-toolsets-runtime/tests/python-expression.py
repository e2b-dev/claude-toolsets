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
if request.get("install"):
    print(module.RUNTIME_SOURCE)
elif "file_input" in request:
    print(module.file_input_expression(**request["file_input"]))
elif "validation" in request:
    arguments = module.file_input_validation_arguments(**request["validation"])
    print(json.dumps({"functionDeclaration": module.FILE_INPUT_VALIDATION, "arguments": arguments}))
else:
    print(module.expression(request["operation"], request["args"]))
