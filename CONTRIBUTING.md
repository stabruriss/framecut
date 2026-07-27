# Contributing to Framecut

Thanks for helping improve Framecut.

## Before opening an issue

- Check whether the TIFF falls within the supported formats documented in the README.
- Remove private photographs and metadata from any reproduction file.
- Prefer a small synthetic TIFF that demonstrates the problem.
- Include the Chrome version, operating system, TIFF dimensions, bit depth, channel count, compression, layout, and orientation.

## Development

Framecut requires Node.js `20.19+` or `22.12+`.

```bash
npm ci
npm test
npm run build:single
```

Open `dist-single/Framecut.html` directly in desktop Chrome for the release-path smoke test.

## Pull requests

- Keep changes focused and avoid unrelated formatting.
- Add or update tests for changes to geometry, export, or TIFF handling.
- Run the test suite and single-file build before submitting.
- Describe any format compatibility or metadata-preservation impact.
- Do not commit generated `dist/`, `dist-single/`, dependency, or engine-cache directories.

By contributing, you agree that your contribution is licensed under the MIT License.
