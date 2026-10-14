"""Package only the built editor, a Node server, and third-party notices."""

import json
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parent.parent
version = json.loads((root / "package.json").read_text())["version"]
destination = root / "release" / f"craft-studio-{version}-portable.zip"
destination.parent.mkdir(exist_ok=True)
dist = (root / "dist").resolve(strict=True)
if not (dist / "index.html").is_file():
    raise SystemExit("Run npm run build first.")

licenses = {
    "opentype.js": "LICENSE",
    "svgpath": "LICENSE",
    "svg-path-bbox": "LICENSE",
    "tiny-inflate": "LICENSE",
    "string.prototype.codepointat": "LICENSE-MIT.txt",
}
notices = []
for package, filename in licenses.items():
    directory = root / "node_modules" / package
    metadata = json.loads((directory / "package.json").read_text())
    notices.append(f"{package} {metadata['version']} ({metadata['license']})\n\n" + (directory / filename).read_text())

readme = """Craft Studio 0.1.0 — portable browser-editor prototype

Requires Node.js 22.12 or newer (Node 24 LTS recommended).
No npm install or compiler is needed for this built bundle.

Windows: double-click Start Craft Studio.cmd, then open the printed URL.
macOS/Linux: run `node tools/serve.mjs` from this extracted folder.
URL: http://127.0.0.1:5198 in current desktop Edge or Chrome.
Keep the server terminal open; Ctrl+C stops it. Never open dist/index.html directly.

This is a prototype, NOT an installer or a full Design Space replacement.
No copied Cricut code, fonts or assets are included. No Cricut login required.
Import flat filled SVGs and licensed standalone TTF/OTF fonts. Other SVG features
are rejected, not silently changed. Complex shaping/RTL, raster editing,
weld/slice/offset, grouping, print-and-cut and direct machine support are absent.

Save project downloads a portable .craft.json, with baked outlines. Browser drafts
and imported fonts belong to this browser/profile/origin and can be cleared.
Keep project backups and original font files; they are needed for text edits on
another device. Export SVG, verify dimensions/paths in official Design Space,
and use the official application for cutting.

Tested on macOS Chromium; Windows hardware and cutter handoff are not verified.
No comparative speedup claim is made. See THIRD-PARTY-NOTICES.txt for library licenses.
"""
launcher = r"""@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.12 or newer, then run this launcher again.
  pause
  exit /b 1
)
node tools\serve.mjs
pause
"""

# Exclusive creation avoids overwriting an existing bundle unexpectedly.
with zipfile.ZipFile(destination, "x", zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(dist.rglob("*")):
        if not file.is_file():
            continue
        if not file.resolve().is_relative_to(dist):
            raise ValueError("Build contains an external symlink")
        archive.write(file, "dist/" + file.relative_to(dist).as_posix())
    archive.write(root / "tools" / "serve.mjs", "tools/serve.mjs")
    archive.writestr("README.txt", readme)
    archive.writestr("Start Craft Studio.cmd", launcher.replace("\n", "\r\n"))
    archive.writestr("THIRD-PARTY-NOTICES.txt", "\n\n" + ("\n\n" + "=" * 72 + "\n\n").join(notices))
    archive.writestr("package.json", json.dumps({"name": "craft-studio-portable", "version": version,
        "private": True, "type": "module", "scripts": {"start": "node tools/serve.mjs"}}, indent=2))
print(f"Created {destination.relative_to(root)} ({destination.stat().st_size:,} bytes)")
