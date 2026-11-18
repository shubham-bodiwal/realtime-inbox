# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org).

## Unreleased

### Added

- Biome lint (`pnpm lint`), contributing guide, code of conduct, security policy, issue and PR templates.
- `server/examples/resend.mjs`: a protocol walk-through that shows a retried send being deduplicated.

### Changed

- Complete package metadata.
- Smaller demo GIF (under 500 KB).

### Fixed

- Unread badge, presence dot and typing indicator are announced correctly by screen readers.
- No console warning when the client unmounts while a socket is still connecting.

### Removed

- GitHub Actions workflow; checks run locally.

## 0.1.0 - 2026-11-18

### Added

- Initial release: `ws` server with per-conversation sequencing, dedupe and resume; React agent console and customer widget.
