# Changelog

All notable changes to `@krtuworks/sdk`. Versions follow semantic versioning; a breaking change is marked **Breaking**.

## Unreleased

## 1.0.12 - 2026-11-26

### Fixed
- A page brought back with the browser's back button (from the back-forward cache) opens a session again. Before, leaving the page ended its session and none opened on the way back, so later play and events had no session.
- A level in play stays open while the page waits in the back-forward cache, so finishing it after coming back counts. Before, leaving the page told the level as quit and the later finish was lost. A page that goes for good still quits it.
- A page loaded in a background tab counts no active time until it is shown, and the time a page waits in the back-forward cache is not counted. Before, both counted as play, in sessions, level times and position samples.

## 1.0.11 - 2026-11-26

### Added
- `samplePosition(position)`: the game reports where the player is as often as it likes; at most one `position_sample` per `positionSampleSeconds` (default 10) of active play goes out with the seconds since the one before, for the time heat map.

### Fixed
- The `position_sample` event belongs to its own module switch, `positions`, as on the server, and only a game sends it. Before, the SDK counted it as one of the app's own events: with `customEvents` off it was dropped, and with `customEvents` on it was sent even while the server's switch was off.
- Node: awaiting a held settings save keeps the process running until the save goes (at most 30 seconds). Before, a script that awaited it could exit first, losing the save with the default memory store.

## 1.0.10 - 2026-11-26

### Fixed
- Two settings saves started back to back can no longer land in the wrong order. Before, a large save started first could be stored after a smaller save started later, because its order was taken only after its content was hashed; the older settings then replaced the newer ones on the server.

## 1.0.9 - 2026-11-26

### Fixed
- An A/B group's value (`value`) is used only while the `abTests` module is on; switching the module off now gives the config's own value. Before, the group's value stayed in force.
- A new player starts without the last player's A/B values and statistics choice. Before, after an account change `value` kept the previous player's groups until `refreshExperiments` ran, and a player with no choice kept on the device inherited the previous player's statistics opt-out when the server could not be asked. An A/B or opt-out answer that arrives after the player changed is not applied.
- `shutdown()` while a session open is still on its way no longer lets the late answer reopen the session or send heartbeats; the session the late answer names is ended.

## 1.0.8 - 2026-11-26

### Fixed
- A refresh the server refuses (a frozen app answers `app_suspended`) no longer deletes what is queued. Before, the refusal reached the queues as if the server had rejected the item, so waiting events, bug reports and saves were dropped. An error raised while the player's credentials are fetched or refreshed (`KrtuworksError.authLayer`) now keeps every queued item and backs the queue off.
- A save is kept on the device when the server refuses it for a reason that can lift: `account_merged` (it waits for `adoptWaiting` or `discardWaiting`), `sanctioned`, `account_deletion_pending`, `switched_off`, `module_disabled`, `app_suspended`. Before, any non-retryable refusal deleted the save. Events, bug reports and progress also wait on these refusals and back off 15 minutes (or the server's Retry-After) instead of retrying at once.
- A deleted account (`401 account_deleted`) signs the player out with reason `account_deleted` and drops what waited for them; before, the queues retried forever and the player stayed signed in.
- A transient `409 app_transferring` or `account_merging` on a bug report's screenshot keeps the screenshot for another try; before it was dropped although the report was accepted.
- A failed session open is tried again (growing wait, the server's Retry-After, the page coming back online, the next flush); before, one failure left the whole run without a session. An open in flight for another player is no longer handed to the player who replaced them.
- A remote config answer that is not a config (a 200 from a captive portal or proxy) is a failed fetch: the kept copy stays and nothing is stored. Before, it replaced the kept config with an empty one and switched every owner switch off.
- An open level attempt belongs to its player: after the player changes, `complete`, `fail` and the rest are not told under the new player. A level started before any player goes on to the first player.
- A guest's age answers are written under the identity lock, so a concurrent sign-in or merge can no longer be overwritten. A refused date of birth (`too_young`, `invalid_birth_date`) ends the stored request instead of being tried at every launch, and new terms alone (`acceptedTerms`) update a stored request.
- Events a refused store write took stay in memory and are written next time; before, they were lost.
- The event queue's 30-day limit, `Retry-After` dates and the conflict screen's "Newer" mark are read on the server's clock, not the device's. A device clock that was behind no longer drops events or steers the player to the cloud save.
- A save refused as `file_conflict` after a 202 carries the slot's current version (`details.current`), so `ui.save` opens the chooser.
- Sign-ins the player never came back to are swept from the store. The refusals kept for diagnostics (`progressRefusals`) are bounded at 100, and a bug report's wait entry goes with the report.
- A pending deletion and a deleted account have their own error screens (no retry loop): "cancel the deletion or download your data".

### Added
- Settings saves (no `base`) go out at most once per 30 seconds per slot, the newest content winning, and at once when the page is hidden or `shutdown()` runs; `files.flushWrites()` does it on demand. A `too_many_writes` answer is tried again after its Retry-After.
- `{ type: 'merging', state: 'started' | 'ended' }` identity change while the server answers `account_merging`.
- `"firstLaunch": "online"` in `krtuworks-config.json`, `krtu.startup` (`ready` | `first_launch_offline`) and `onStartupChange`; `krtu.serverNow()`.
- `KrtuworksError.authLayer`, `.waiting` and `.keepsQueued`; the `signed_out` identity change carries `subject` when the reason is `account_deleted`.

## 1.0.7 - 2026-11-25

### Fixed
- A bug report carries only its own player's recent events, log lines and frame rate. Before, after a switch to another account in the same run, the new player's report took the previous player's events and log lines too. What was recorded before anyone signed in goes to the first player, like the events queue.
- A different player signed in by another tab or instance sharing the same storage is now taken up like a sign-in here: the identity change is reported and a session opens for that player. Before, the SDK switched to that player silently. A plain token refresh by another tab stays silent.
- The events and log lines a bug report attaches are now limited in bytes, not characters, so a report in Chinese, Japanese or other multi-byte text stays under the server's size limit. Before, such a report could be refused as too large and dropped.

## 1.0.6 - 2026-11-25

### Fixed
- The save screens answer only for the player who opened them. Before, when the player signed out or another account signed in while the "which save to keep" screen was open, the choice and the save could reach the new account. Now `ui.save` and `ui.resolveMergedSaves` end with `context_changed` and nothing is saved.

## 1.0.5 - 2026-11-25

### Added
- Ready-made screens (`@krtuworks/sdk/ui`): `createUi(krtu)` and `await ui.ensurePlayer()` show the age and terms screen before a new guest, a screen for players under 13 (the game goes on offline and the screen is not shown again until their 13th birthday), the screen for newer terms, an error screen with Try again and Keep playing, and finish a sign-in the page came back from. `ui.save(slot, bytes, { base, name })` shows both saves when another device saved first and does what the player picks (`describeSave` adds the game's own chapter, play time or picture to each card). A guest gets the "link a Krtuworks ID" prompt in a corner when the SDK says it is time. `<krtuworks-sign-in>` and `<krtuworks-account>` are a sign-in button and an account chip with its menu. Colours, corners and font are CSS variables (`--kw-accent` …), every sentence can be replaced (`texts`), and a game that draws its own screens gets the same models through `KrtuworksUi` and its own `UiHost`.

## 1.0.4 - 2026-11-22

### Fixed
- A late `account_merged` answer for a player who already left no longer signs out the player who plays now. Before, when a call made for one account was answered after the player had switched to another, the new player's tokens were dropped and the app was told of a merge that was not theirs. Now only the merged player is signed out; its queues still wait for the merge check.
- A session reports only its own time in use. Before, a session opened after another one (a new player, a session the server closed after 30 minutes) started from the whole launch's time, so its first heartbeat could claim an hour of play the session never had. `SESSION_MINUTES` in rich presence counts the session too.
- Every call ends within 30 seconds, answer included (the Unity and Unreal packages already did). Before, a connection that stayed open without finishing its answer held every queue sent after it, and `signOut()` that waits for them. A call cut short is sent again later; every call is safe to repeat.

## 1.0.3 - 2026-11-22

### Fixed
- A player's call is sent only with that player's token. Before, a call refused as expired while the player changed (a sign-in in another tab, a switch of accounts) could be sent again with the new player's token, and a queued save, stat, event or bug report could go out under whoever was signed in when it was sent. Now each call carries the player it was made for, and when the token in hand is another player's nothing is sent (`context_changed`); the work waits for its own player.
- Moving waiting progress to another account (the first sign-in after playing without one, a merge) adds nothing twice when it is cut short (the app closed between its two writes) and run again. The events queue move is safe the same way.
- One waiting save per slot: a newer save takes the place of an older one not sent yet (the older one's call ends with `save_replaced`), and the saves of a slot go in the order they were made, so an older copy never lands after a newer one. Before, every save made offline waited on its own and they went in no set order.

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
