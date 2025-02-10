# Link checker - HTML & Markdown - VSCode Extension

The URL Checker extension for Visual Studio Code is designed to check and validate URLs in HTML and Markdown files. It checks for both working and broken links, highlighting them directly in the editor. This extension is specifically designed for an internal TechComms setup and is not intended for general use.

## Limitation

This extension is intended for internal use within TechComms and is not meant for general public release. It will only work with a specific project folder structure.

## Features

- Validates URLs in HTML and Markdown files.
- Displays diagnostics directly in the editor.
- Supports both internal and external URLs.
- Reports broken URLs with status codes (404, 403, etc.) and marks them with a red indicator.
- Marks working URLs with a blue indicator.
- Concurrent URL checking for improved performance (limit of 50 concurrent requests).
- Supports automatic retrieval of base URLs from configuration files.

## Installation

1. Open Visual Studio Code.
2. Navigate to the Extensions view (Ctrl+Shift+X).
3. Search for `Link checker - HTML & Markdown`.
4. Click `Install`.