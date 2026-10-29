#!/usr/bin/env python3
"""Render the guide with Pandoc, Playwright and Chromium (documentation tools only)."""
import argparse
import shutil
import subprocess
import tempfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-sandbox", action="store_true",
                        help="Disable Chromium's sandbox only for an isolated build container")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    docs = root / "docs"
    stem = "dbatools-mcp-https-deployment-guide"
    pandoc = shutil.which("pandoc")
    chromium = next((path for name in ("chromium", "chromium-browser", "google-chrome")
                     if (path := shutil.which(name))), None)
    if not pandoc or not chromium:
        parser.error("Install Pandoc and Chromium on the documentation build machine")
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        parser.error("Install the Python playwright package on the documentation build machine")
    with tempfile.TemporaryDirectory(prefix="dbatools-guide-") as temp:
        html = Path(temp) / "guide.html"
        subprocess.run([
            pandoc, str(docs / f"{stem}.md"), "--standalone", "--toc", "--toc-depth=1",
            "--metadata=toc-title:Contents", "--embed-resources",
            f"--css={docs / 'deployment-guide.css'}", "--output", str(html),
        ], check=True)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                executable_path=chromium, headless=True, chromium_sandbox=not args.no_sandbox,
                args=["--disable-dev-shm-usage", "--disable-background-networking"],
            )
            try:
                page = browser.new_page()
                # Embedded HTML needs no file navigation or external web resources.
                page.route("**/*", lambda route: route.abort())
                page.set_content(html.read_text(encoding="utf-8"), wait_until="domcontentloaded")
                page.pdf(path=str(docs / f"{stem}.pdf"), print_background=True,
                         prefer_css_page_size=True, display_header_footer=False)
            finally:
                browser.close()
    print(docs / f"{stem}.pdf")


if __name__ == "__main__":
    main()
