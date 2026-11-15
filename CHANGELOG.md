# Changelog

All notable changes to `@krtuworks/sdk`. Versions follow semantic versioning; a breaking change is marked **Breaking**.

## Unreleased

## 1.0.2 - 2026-11-15

### Changed
- No change in this package: the SDK packages share one version, and 1.0.2 fixes the Unreal plugins.

## 1.0.1 - 2026-11-15

### Changed
- No change in this package: the SDK packages share one version, and 1.0.1 fixes the Unity package.

## 1.0.0 - 2026-11-15

First release.

### Added
- `Krtuworks.initialize` with the app's `krtuworks-config.json`, TEST and LIVE environments, the app's type (`GAME`, `MOBILE_APP`, `WEB_APP`, `DESKTOP_APP`).
- Guests with a device key (no sign-in screen), Krtuworks ID sign-in in the browser (PKCE), a guest's progress kept when they sign in.
- Sessions, events (ready-made families and the app's own types), levels and deaths for games.
- Stats and achievements kept on the device until the server has them, never counted twice; platform achievement sync (with the open session: the server mirrors only with the platform account the session proved).
- Cloud saves with conflict handling and resumable uploads.
- Remote config, SDK modules, maintenance and required-update gate, A/B tests, player profile card.
- Bug reports with a screenshot and the "fixed" notice; profile picture reports.
- A guest's account deletion, its cancellation and data copy from inside the app.
- The validator (`validate`) for the release report.
- Leaderboards (the `leaderboards` module): `submitScore` kept on the device until the server has it (a lost answer goes again with the same op id), `getLeaderboards()` and `getLeaderboardEntries()` (global or around the player).
- Rich presence (games only): `setPresence`, `clearPresence`, `setPresenceGroup`, `presenceVisible`, `setPresenceVisible` and the `presence` module. The states and the player's choice are kept per player and revalidated with the ETag; a browser has no platform presence, so a valid `setPresence` answers `no_platform`.
- `getProgress()` stats carry `platformIds` (a stat's name on Steam).
- DLC ownership: `entitlements()` (the licences the server last said, kept per player and environment on the device), `refreshEntitlements()` (`GET /v1/me/entitlements`) and `ownsDlc(key)`. A browser has no platform client to ask, so it answers with what the server confirmed in this launch, else the last server answer kept from an earlier launch.
