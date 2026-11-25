# Krtuworks SDK for JavaScript and TypeScript: instructions for coding agents

`@krtuworks/sdk` connects a web game or app (browser or Node 20+) to Krtuworks: Krtuworks ID sign-in, guests, sessions, events, stats and achievements, cloud files, remote config and A/B tests. It has no dependencies.

## Before you start
- Check the project folder. A `*.uproject` file means Unreal: use the Krtuworks Unreal plugin. `ProjectSettings/ProjectVersion.txt` means Unity: use `com.krtuworks.sdk`. Only a `package.json` with neither means this package.
- Get the app's `krtuworks-config.json` from the partner console (the app's Credentials page) or from the Krtuworks MCP tool `get_setup`. Never write it by hand and never guess an id in it. It holds no secret, so it may be committed.
- In a browser, the app's web client must list the page's origin and the sign-in return address. Krtuworks sets them up on the Credentials page; a sign-in from an origin that is not listed fails.

## Required steps
1. `npm install @krtuworks/sdk`
2. Put `krtuworks-config.json` where the app can import it.
3. Call `Krtuworks.initialize` once, when the app starts, and keep the client it returns:
   ```ts
   import { Krtuworks } from '@krtuworks/sdk';
   import config from './krtuworks-config.json';

   const krtu = await Krtuworks.initialize({ config, environment: 'TEST', platform: 'WEB', build: '1.4.2', redirectUri: 'https://example.com/signed-in' });
   ```
   - `environment`: `TEST` while developing, `LIVE` in the released build. Test players and their data never reach LIVE.
   - `build`: the version label of this build. Give each released build its own label.
   - `platform`: where the app runs (`WEB`, `WINDOWS`, `MACOS`, `LINUX`, `IOS`, `ANDROID`, `STEAM` …).
   - `redirectUri` (web): the sign-in return address. It must be one of the web client's registered https return addresses, set on the partner console's Credentials page. `signIn()` throws without it; `signIn({ redirectUri })` can give it later.
   - Under Node there is no window, so the SDK uses the native client (the config's `clientId`, not `webClientId`) and needs no `redirectUri`. Use `platform: 'WINDOWS'`, `'MACOS'` or `'LINUX'`, not `'WEB'`.
4. Sign the player in. `await krtu.signInAsGuest({ birthDate: 'YYYY-MM-DD' })` makes a guest account with no sign-in screen: the app's age screen asks the birth date (13 or older) and shows the Krtuworks ID Terms and Privacy Notice, which the player accepts (`acceptedTerms` defaults to `CURRENT_TERMS`). On the next start the same device signs in again with no input. `await krtu.signIn()` opens Krtuworks ID; on the return page call `await krtu.completeSignIn()`. A guest who signs in keeps their progress.
5. Call `await krtu.shutdown()` when the app closes (Node). In a browser the SDK sends on its own when the page is hidden.

## Rules
- Events: `krtu.track(type, data)` with a ready-made family (`screen_view`, `economy`, `item`, `performance`, `settings`, `error` …) or a type defined on the console. It returns `false` when nothing was kept (the module is off, statistics are switched off, or the player opted out); that is not an error.
- Stats and achievements: `incrementStat`, `setStat`, `unlockAchievement`. They are kept on the device until the server has them and are never counted twice: do not add your own retry.
- Leaderboards: `submitScore(key, value, { details? })` (a whole number below 10^15, details 1 to 64 bytes) is kept on the device like a stat and never lost; the server decides what the board keeps. Read with `getLeaderboards()` (the player's own score and rank per board) and `getLeaderboardEntries(key, { scope: 'global' | 'around', limit, offset })`. Names shown are Krtuworks usernames (`null`: show "Player"). Reads throw `module_disabled` while the leaderboards module is off; scores wait. The SDK never writes scores to a platform; the server mirrors them.
- Rich presence (games only): `setPresence(key, params?)` answers `{ applied, reason? }` and never throws for those reasons (`not_game`, `module_disabled`, `hidden`, `unknown_state`, `param_missing`, `states_unknown`). The states are declared on the console; `LEVEL` (the open `level.start`) and `SESSION_MINUTES` fill themselves. A browser has no platform presence, so a call that passes every rule answers `no_platform`; `clearPresence()` and `setPresenceGroup()` do nothing there. The player's choice: `presenceVisible()` (cached, `null` until known) and `await setPresenceVisible(bool)`; false makes `setPresence` answer `hidden`.
- DLC ownership (games only): `ownsDlc(key)` takes the DLC's product key from the console and answers at once with a boolean (`false` for an unknown key). It reads what the server confirmed in this launch, else the last server answer kept on the device, so it works offline after one online launch. `entitlements()` lists the licences (`sku` `base` first, then the DLCs; `status` `ACTIVE`, `REVOKED` or `null`; `checked` is true for what the server confirmed in this launch) and `await refreshEntitlements()` asks the server now. Do not keep your own ownership flags.
- Levels and deaths (`krtu.level.*`, `death`) are for games only; in an app they do nothing.
- Cloud files: `krtu.files.save(slot, bytes)` and `krtu.files.read(slot)`. A save conflict (`file_conflict`) carries the current version: let the player choose, do not overwrite.
- Check `krtu.gate()` at start: it tells about maintenance and a required update.
- Ready-made screens: `import { createUi } from '@krtuworks/sdk/ui'`, `const ui = createUi(krtu)`, then `await ui.ensurePlayer()` before the game starts instead of calling `signInAsGuest` yourself. It shows the age and terms screen for a new guest, keeps a player under 13 offline, finishes a sign-in the page came back from, and never throws: it answers `signedIn`, `redirecting` or `offline`. Save with `await ui.save(slot, bytes, { base, name })` to let the player choose when another device saved first; a `kept: 'there'` answer carries the other save's bytes, which the game loads. Put `<krtuworks-sign-in>` and `<krtuworks-account>` where the page wants them. Change colours with the `--kw-*` CSS variables and sentences with `createUi(krtu, { texts: { 'age.title': '…' } })`; do not copy or restyle the screens' markup.
- Errors are `KrtuworksError` with a `code`. A network error does not lose data: the SDK keeps what it has and sends it later.
- Never put a server key or any other Krtuworks secret into app code. This package needs none.

## Verify
Run the validator against TEST. It checks the config, the build label and the platform, then makes a test round (sign-in, session, event, remote config, cloud save, progress, bug report) with the app's own setup:
```ts
import { validate } from '@krtuworks/sdk';

const report = await validate({ config, platform: 'WEB', build: '1.4.2', redirectUri: 'https://example.com/signed-in' });
console.log(report.ok, report.checks);
```
`report.ok` must be `true`. Each check is `PASSED`, `FAILED` (with `detail`) or `SKIPPED` (a module that is off, an app with no save slots or no achievements). A build whose report is not green is not released in LIVE. In a browser (the web client) the validator also needs an https `redirectUri`, one of the web client's registered return addresses.
