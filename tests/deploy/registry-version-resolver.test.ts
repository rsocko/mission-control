import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const resolverPath = join(
  process.cwd(),
  '.github',
  'scripts',
  'resolve_registry_version.py',
);
const python = process.platform === 'win32' ? 'python' : 'python3';

function runPython(script: string): void {
  execFileSync(python, ['-c', script], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

describe('registry version resolver', () => {
  it('uses the established clean-registry baseline and increments semantic versions', () => {
    const script = `
import importlib.util

spec = importlib.util.spec_from_file_location("resolver", ${JSON.stringify(resolverPath)})
resolver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resolver)

assert resolver.compute_next_version("next_patch", None) == "0.1.0"
assert resolver.compute_next_version("next_minor", None) == "0.1.0"
assert resolver.compute_next_version("next_major", None) == "1.0.0"
assert resolver.compute_next_version("next_patch", (1, 2, 3)) == "1.2.4"
assert resolver.compute_next_version("next_minor", (1, 2, 3)) == "1.3.0"
assert resolver.compute_next_version("next_major", (1, 2, 3)) == "2.0.0"
assert resolver.latest_semver(["latest", "sha-deadbee", "0.9.9", "v1.2.3", "1.2.2"]) == ("v1.2.3", (1, 2, 3))
`;

    expect(() => runPython(script)).not.toThrow();
  });

  it('resolves next_patch to 0.1.0 when the registry has no semantic tags', () => {
    const script = `
import importlib.util
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("resolver", ${JSON.stringify(resolverPath)})
resolver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resolver)

with tempfile.TemporaryDirectory() as directory:
    output_path = Path(directory) / "github-output"
    environment = {
        "REGISTRY_REPOSITORY": "ghcr.io/rsocko/mission-control",
        "VERSION_MODE": "next_patch",
        "GITHUB_OUTPUT": str(output_path),
    }
    with patch.dict(os.environ, environment, clear=True):
        with patch.object(resolver, "fetch_tags", return_value=[]):
            assert resolver.main() == 0
    values = dict(
        line.rstrip().split("=", 1)
        for line in output_path.read_text(encoding="utf-8").splitlines()
    )

assert values["resolved_tag"] == "0.1.0"
assert values["latest_tag"] == ""
`;

    expect(() => runPython(script)).not.toThrow();
  });

  it('validates explicit immutable tags', () => {
    const script = `
import importlib.util

spec = importlib.util.spec_from_file_location("resolver", ${JSON.stringify(resolverPath)})
resolver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resolver)

assert resolver.validate_explicit_tag("2.4.1") == "2.4.1"
for tag in ["", "latest", "bad tag", "-invalid"]:
    try:
        resolver.validate_explicit_tag(tag)
    except ValueError:
        pass
    else:
        raise AssertionError(f"expected invalid explicit tag: {tag}")
`;

    expect(() => runPython(script)).not.toThrow();
  });

  it('exchanges Docker basic credentials for a GHCR bearer token', () => {
    const script = `
import importlib.util
import io
from email.message import Message
from unittest.mock import patch
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location("resolver", ${JSON.stringify(resolverPath)})
resolver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resolver)

class Response:
    def __init__(self, body):
        self.body = body
        self.headers = Message()
    def __enter__(self):
        return self
    def __exit__(self, *_):
        return False
    def read(self):
        return self.body.encode("utf-8")

calls = []
def urlopen(request, timeout):
    calls.append((request.full_url, request.get_header("Authorization")))
    if len(calls) == 1:
        headers = Message()
        headers["WWW-Authenticate"] = 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:rsocko/mission-control:pull"'
        raise HTTPError(request.full_url, 401, "Unauthorized", headers, io.BytesIO())
    if len(calls) == 2:
        return Response('{"token":"registry-bearer-token"}')
    return Response('{"tags":["0.1.0","0.2.0"]}')

with patch.object(resolver.urllib.request, "urlopen", urlopen):
    tags = resolver.fetch_tags(
        "https://ghcr.io",
        "rsocko/mission-control",
        {"Authorization": "Basic docker-login-token"},
    )

assert tags == ["0.1.0", "0.2.0"]
assert calls[0][1] == "Basic docker-login-token"
assert calls[1][0].startswith("https://ghcr.io/token?")
assert calls[1][1] == "Basic docker-login-token"
assert calls[2][1] == "Bearer registry-bearer-token"
assert resolver.candidate_bases("ghcr.io", authenticated=True) == ["https://ghcr.io"]
try:
    resolver.candidate_bases("http://ghcr.io", authenticated=True)
except ValueError:
    pass
else:
    raise AssertionError("authenticated registry access must reject plaintext HTTP")
`;

    expect(() => runPython(script)).not.toThrow();
  });
});
