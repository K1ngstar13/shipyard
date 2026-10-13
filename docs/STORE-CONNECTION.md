# App Store Connect and TestFlight, automatically

From 2.4.0, Shipyard runs this for every game:

1. **Import the game.** Shipyard reads it and drafts the listing. The App ID is generated from the name, for example *Block Pets* → `elevatr.llc.blockpets`.
2. **Prepare the app.** On Listing (step 4), Shipyard searches the App Store for the name as you type. If another developer already uses it, Continue is blocked and Shipyard offers names that are free. The home-screen name follows the App Store name unless you type your own. The App ID follows the name until the first upload.
3. **Build and upload.** Choose **Send to my phone**. The run has these jobs (the setup job also creates the TestFlight group with you in it):
   - *Preflight* checks the listing and searches for the name again.
   - *App Store Connect setup* registers the bundle ID, finds the app record, and renames the record if you renamed the game.
   - *App Store* builds, signs, and uploads on a Mac.
   - *TestFlight setup* waits for Apple to process the build, answers export compliance, adds the build to your internal group, and adds your testers.
4. **Test on your iPhone.** Apple emails a TestFlight invitation the first time. Open TestFlight and tap Install.
5. **Submit for approval**, only when you choose it, with a second tap to confirm.

## The one manual step: the app record

Apple lets only the account holder create an app record, and only on the website; its API can't do it. The first time you send a new game, the *App Store Connect setup* job stops in seconds, before any paid Mac build. The game sheet then shows **Create the App Store Connect record** with each value and a Copy button:

| Field | Value |
| --- | --- |
| Platform | iOS |
| Name | the App Store name |
| Primary language | English (U.S.) |
| Bundle ID | the App ID (already registered for you) |
| SKU | the game's folder name |

If Apple says the name is taken, rename the game in Shipyard. The App ID follows the new name because nothing has been uploaded yet. Then send again.

## The App ID lock

The App ID locks once any build is uploaded to App Store Connect. Apple ties the app record, its TestFlight builds, and every future update to that ID, and never lets it change or be reused. Players never see it. You can still change the App Store name and the home-screen name; Shipyard renames the record in App Store Connect on the next build.

Block Pets is the example: it was uploaded as `elevatr.llc.blockpals` before it was renamed, so that ID is permanent. This is harmless.

## TestFlight settings

In `shipyard.config.json`:

```json
"testflight": {
  "group": "Elevatr Internal Testing",
  "testers": ["kingr13@hotmail.com"]
}
```

- **group**: the internal group for every app. As soon as an app's record exists, Shipyard creates the group (or reuses an existing internal group) and adds the testers. You never set it up per app.
- **testers**: Apple Accounts to add. They must be users under App Store Connect → Users and Access (yours is). Leave the list empty to add every team member; that needs an Admin API key.
- **Invitation**: Apple emails each new tester once per app. Accept it on your iPhone, and new builds then show up in the TestFlight app.

## Status

The board shows **PROCESSING** while Apple works, **TESTING** when the build is installable, and **TO DO** when something needs you. Open the game to see the build, group, testers, and the exact next step, and tap **Check TestFlight now** to ask Apple again. The *TestFlight status* workflow also re-checks waiting games every hour and finishes adding them to the group.

Everything Shipyard learns from Apple is saved in `games/<game>/release.json`. Shipyard writes that file itself; don't edit it by hand.

## API key permissions

The App Store Connect API key (`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`) needs **App Manager** or **Admin** access. Admin also lets Shipyard list your team and add everyone as testers.
