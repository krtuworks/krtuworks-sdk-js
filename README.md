# Krtuworks SDK for JavaScript and TypeScript

`@krtuworks/sdk` connects a web game or app (browser or Node 20+) to Krtuworks: Krtuworks ID sign-in and guests with no sign-in screen, sessions, events and dashboards, stats, achievements and leaderboards, cloud saves, remote config and A/B tests, bug reports and the release report. It has no dependencies.

```sh
npm install @krtuworks/sdk
```

```ts
import { Krtuworks } from '@krtuworks/sdk';
import config from './krtuworks-config.json';

const krtu = await Krtuworks.initialize({ config, environment: 'TEST', platform: 'WEB', build: '1.0.0', redirectUri: 'https://example.com/signed-in' });
await krtu.signInAsGuest({ birthDate: '2000-01-31' });
krtu.track('screen_view', { screen: 'menu' });
```

Ready-made screens for the age question, the sign-in button, the account chip and save conflicts:

```ts
import { createUi } from '@krtuworks/sdk/ui';

const ui = createUi(krtu);
await ui.ensurePlayer();
```

Your app's `krtuworks-config.json` comes from the app's Credentials page in the [partner console](https://partner.krtuworks.com).

- Documentation: [partner.krtuworks.com/docs](https://partner.krtuworks.com/docs)
- Coding agents: [`AGENTS.md`](AGENTS.md)
- Changes: [`CHANGELOG.md`](CHANGELOG.md)
- Support: support@krtuworks.com

Licensed under the [Apache License 2.0](LICENSE). The Krtuworks name and logo are not covered by the licence ([`NOTICE`](NOTICE)).
