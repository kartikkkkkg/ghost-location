# Roam setup guide

Roam runs on your computer and sends simulated locations to a phone over a USB data cable or the same Wi-Fi network. It is free and open source. No Roam account, API key, subscription, jailbreak, or root is needed.

## Run the current version from source (recommended)

The packaged 0.1.7 download below is the previous release. The current code — the Wi-Fi fixes, route modes with realistic pacing, saved routes and history, GPX import/export, and phone-browser web control — runs from source:

**You need:** Git, Node.js 20 or newer, and (iPhone only) Python 3. Mac: Apple silicon or Intel. Windows: 64-bit.

```sh
git clone https://github.com/kartikkkkkg/roam.git
cd ghost-location
git checkout fix/wifi-apply-button   # the branch carrying the current work
npm install
npm run runtime:ios       # iPhone only: builds the iOS runtime (one-time, a few minutes)
npm run runtime:android   # Android only: downloads the official ADB tools (one-time)
npm start
```

- `npm start` builds the interface and opens the app. Leave that terminal open; closing it quits the app.
- Instead of the two `runtime:` commands, you can open the app and click **Prepare device tools** in **Settings** — it does the same preparation.
- **Updating later:** quit the app, then `git pull`, `npm install`, and `npm start` again. Re-run `npm run runtime:ios` if an update changes the `sidecar/` folder.
- Then follow **Choose your configuration** and the checklist for your computer + phone below — they apply exactly the same to the source build.

The rest of this guide (phone preparation, Wi-Fi connection, troubleshooting) applies to both the source build and the packaged release unless a section says otherwise.

## Download and open

Download **Roam 0.1.7** from [GitHub Releases](https://github.com/Blueturboguy07/ghost-location/releases/tag/v0.1.7) or use the [Publik installation guide](https://publikhq.com/ghost/install).

| Your computer | Download |
| --- | --- |
| Mac with an Apple chip (M1 or newer) | `Roam-0.1.7-mac-arm64.dmg` |
| Mac with an Intel processor | `Roam-0.1.7-mac-x64.dmg` |
| Windows PC with an Intel/AMD 64-bit processor | `Roam-0.1.7-win-x64.exe` |

On Mac, **Apple menu → About This Mac** identifies the chip. On Windows, look at **Settings → System → About → System type**. Windows ARM and Linux are not release targets. Native builds are checked on macOS 15 and Windows Server 2025; other OS versions have not been rehearsed.

**Mac:** open the DMG, drag **Roam** into **Applications**, then open it from Applications. The app is unsigned and not notarized. If macOS blocks the launch, check **System Settings → Privacy & Security → Open Anyway**. If it instead reports the app as damaged, first compare the download with `SHA256SUMS.txt` on the release page and download it again if the checksum differs. For a matching download that you choose to trust, the scoped command below removes its quarantine flag; it does not sign the app or verify its safety:

```sh
xattr -dr com.apple.quarantine /Applications/Roam.app
```

**Windows:** run the EXE and follow the installer. The release is unsigned. If SmartScreen shows **Windows protected your PC**, inspect the file and publisher warning; use **More info → Run anyway** only if you choose to trust this download. A managed computer may block unsigned apps.

The installer includes ADB, the iPhone runtime, and the Android location helper. You do not need Node.js, Python, Xcode, Android Studio, or Appium Server to use it.

## Choose your configuration

On first launch, choose your computer and phone, complete the matching checklist, and select **Continue to map**. **Setup** in the toolbar opens the checklist again. The checklist is guidance; the connected phone must also appear as **Ready** before starting a location session.

Use one unlocked phone and a USB cable that carries data. Keep the computer online for the first preparation. Charging alone does not confirm a data connection.

### Mac → iPhone

1. Connect and unlock the iPhone. In Finder, select the iPhone and choose **Trust** if asked; confirm **Trust** on the phone.
2. On iPhone, open **Settings → Privacy & Security → Developer Mode**. Enable it, restart, and confirm after restarting. Enter the passcode on the phone itself. See [Apple's Developer Mode instructions](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device).
3. In Roam, select the iPhone. If it shows **Setup needed**, click **Prepare** and wait while the matching developer support image is downloaded and mounted.
4. Continue when the phone shows **Ready**. If Developer Mode is missing, connect and trust the phone first, attempt Prepare, then check the setting again. Follow Roam's specific error if preparation still fails.

The iPhone adapter targets **iOS 17.4 and later**. New iOS versions can require upstream support updates.

### Windows → iPhone

1. Install or update **Apple Devices** from the Microsoft Store and open it once. Connect the iPhone and confirm that Apple Devices can see it. [Apple explains connecting and trusting a PC](https://support.apple.com/en-us/109054).
2. Unlock the iPhone and approve **Trust** on the computer and phone when asked.
3. Enable **Settings → Privacy & Security → Developer Mode**, restart, then confirm it on the phone.
4. In Roam, select the iPhone and click **Prepare** if shown. Wait for **Ready**.

If Roam reports **Apple USB services are unavailable**, repair Apple's device-support installation and reconnect. The upstream iPhone library recommends Microsoft Store iTunes for its Windows USB service prerequisite; see the [pymobiledevice3 Windows prerequisites](https://github.com/doronz88/pymobiledevice3#windows). Do not install USB drivers from random download sites.

### Mac → Android

1. On Android, open **Settings → About phone**, find **Build number**, and tap it seven times. Some phones place it under **Software information**. Enter your screen lock if asked.
2. Open **Developer options** and enable **USB debugging**. Menu locations vary by manufacturer.
3. Connect and unlock the phone. Approve **Allow USB debugging?** for your own computer. A separate Mac USB driver is normally unnecessary.
4. In Roam, select the phone and click **Prepare**. This installs **Appium Settings**, grants its location permissions, and selects it as the mock-location provider.
5. If Android requires a manual choice, open **Developer options → Select mock location app → Appium Settings**. Keep Android Location switched on and allow the helper's requested location access. Return to Roam and check for **Ready**.

The Android adapter targets **Android 8 and later**. See [Android's developer settings](https://developer.android.com/studio/debug/dev-options) for menu and permission details.

### Windows → Android

1. Enable **Developer options** and **USB debugging** as above.
2. Connect and unlock the phone; accept its USB debugging authorization prompt.
3. If Windows cannot find the phone, install your manufacturer's ADB USB driver using [Android's official OEM driver links](https://developer.android.com/studio/run/oem-usb). Reconnect, and try a direct USB port with a data cable.
4. Select the phone in Roam and click **Prepare**. Approve the helper's permissions; if prompted, select **Appium Settings** under **Select mock location app**.
5. Wait for **Ready** before setting a location.

## Set one location

1. Choose **Fixed location**. Search for a place and select a result, click the map, or enter latitude/longitude and select the coordinates.
2. Check the selected phone and point. Selecting a pin changes the preview only.
3. Click **Set location**. For another point, select it and click **Update location**.
4. Open a map on the phone, enable its location permission, and use its current-location button. Confirm the phone shows the selected area.

Roam displays command acknowledgements on iPhone and helper readbacks on Android. Those are connection feedback, not independent proof of the location consumed by another app. Some apps reject or cache simulated locations.

## Follow a road route

1. Select **Route**. Build the stop list in travel order: search for a place or drop a pin, then click **Add selected pin to route** — up to 12 stops. If a location session is already active, **Add current position** starts the route where the phone already is, so there is no jump. Remove a stop with its **×**.
2. Choose how it travels: **Walk** (3 mph), **Cycle** (12 mph) or **Drive** (45 mph), or type any custom speed from 0.5 to 250 mph.
3. **Realistic pacing** (on by default) makes the movement human: the phone accelerates gently, eases off for bends, slows into junctions, and briefly stops at sharp turns (longer at junctions when driving). Turn it off for a perfectly constant speed.
4. **Loop route** (off by default): on arrival the phone turns around and drives back along the same roads, back and forth — it never teleports back to the start. A route whose end is within about 30 m of its start simply laps.
5. Click **Plan road route** and check the road line, distance and time. Pins may snap to nearby roads; disconnected roads fail planning. Change the mode or speed and re-plan only if you want a different road profile — **Start route** also accepts new speed/pacing/loop choices on an existing plan.
6. Click **Start route**. Roam sends a new target about every second. **Pause** holds the current point; **Resume** continues. Arrival holds the destination until you restore.
7. If the connection drops mid-route, movement holds at the last point and **resumes on its own** when the same phone reconnects — no need to touch anything. If the computer sleeps, wake it and the same recovery happens.
8. **Slow connections no longer pause routes.** Points go out as fast as the phone accepts them while the position stays true to elapsed time. You may see a note that the connection is slow; the route keeps its pace.
9. Click **Restore real location** when finished. Allow the phone's map a moment to refresh before unplugging.

More route tools, under the route panel:

- **Save route** — name the planned route; saved routes appear in a list with **Start** (one click), **Load** (review first) and **Delete**. Up to 50.
- **Drive back** — reverses the current plan, so the phone returns along the same roads to where the route began.
- **Export GPX / Import GPX** — download the planned route as a `.gpx` track, or load any track file (from a fitness app, a friend, a route planner) as a ready-to-drive route.
- **Recent routes** — completed and partially driven routes are remembered (up to 20) with a **Replay** button.

Keep Roam running and the computer awake during a route. Minimizing Roam does not stop playback.

## Control from your phone's browser (web control)

Once Roam is running on your computer, you can drive it from the phone itself — no cable, nothing to install on the phone:

1. In the desktop app, open **Settings → Web control**. It shows a URL (like `http://192.168.1.20:8420`) and a **6-digit PIN**. The PIN is regenerated every time the app starts.
2. Put the phone on the **same Wi-Fi network** as the computer, open the URL in the phone's browser, and enter the PIN.
3. The web page is the full control surface: search or tap the map to set a location, build a route stop-by-stop with **Add pin to route** (or **Drive here** for a quick one-stop route), choose mode/speed/pacing/loop, start saved routes and places, pause/resume, and **Restore real location**.

Notes: web control works only on your local network — the address is not reachable from the internet. Anyone on the network still needs the PIN, and wrong guesses are rate-limited. Keep the desktop app running; the phone page talks to it.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| No phone / Disconnected | Unlock it, reconnect a data cable directly, then click the refresh button. Check the Trust or USB debugging prompt. On Windows, check the appropriate Apple/OEM driver. |
| Setup needed | Click Prepare while online. Complete Developer Mode or the mock-location selection on the phone. |
| Location jumps back / acknowledgements stop | Keep the computer awake. Check USB, reconnect the same phone, and use Retry or Resume. Confirm the result in the phone's map. |
| New phone blocked by an active session | Restore the previous session first. Old unresolved records are cleared when another usable phone appears; clearing a record does not restore the absent phone. |
| No Route tab | Open the installed Roam 0.1.7 desktop app. A stale running copy must be quit and reopened; normal quit attempts to restore its active phone first. A browser preview cannot control USB phones. |
| Search or route planning fails | Check internet access. Try coordinates or a map pin. Public Photon, OSRM, and map services can be unavailable. Route planning needs reachable driving roads. |
| Restore failed after unplugging | Reconnect the same phone and click Restore. Do not assume unplugging restored it. If iPhone simulation remains stuck, restart the iPhone. |
| Android keeps the simulated point | Reconnect and Restore. If needed, stop Appium Settings on the phone and set Select mock location app to None, then refresh the phone's map. |

## Privacy and tested scope

Roam has no account or telemetry. Device identifiers, saved places, and a recovery record stay on the computer. Map viewing requests OpenStreetMap tiles, submitted searches go to Photon, and planning sends stop coordinates to OSRM. These public services have usage limits and no uptime guarantee. Route playback itself does not contact OSRM.

Mac → iPhone has been used successfully on a physical phone. Windows → iPhone, Windows → Android, and Mac → Android have software/adapter coverage; they have **not all been verified with physical USB phones**. Native installer builds are separate from end-to-end phone compatibility. See [validation](docs/validation.md) and the [hardware test matrix](docs/hardware-test-matrix.md).

For help, [open an issue](https://github.com/kartikkkkkg/roam/issues) with the Roam version, computer OS/processor, phone OS, and exact error. Remove phone identifiers and private locations from logs and screenshots.

## Connect over the same Wi-Fi network

After a phone is working over USB, Roam offers **Switch to Wi-Fi** if your computer has an active Wi-Fi connection. Choose **Stay on USB** to dismiss the offer for that phone. You can always open **Connection: USB · Change** below the Phone card and click **Switch to Wi-Fi**.

Keep both devices on the same network and leave USB connected until Roam confirms the switch. Roam checks the same phone over Wi-Fi, carries over the current location, and resumes a running route from its held point. A brief interruption can occur while reopening the iPhone transport. If the Wi-Fi session fails, Roam tries USB recovery; if both connections fail it keeps the session unresolved so you can Retry or Restore. Returning from Wi-Fi to USB still requires Restore first.

### iPhone on Mac or Windows

1. Connect by USB once. Unlock and trust the computer; enable Developer Mode. Windows needs Apple's device-support installation as described above.
2. Prepare and select the iPhone in Roam. Click **Switch to Wi-Fi** in the offer or connection panel. Roam saves the existing pairing record locally and enables Apple's wireless connection setting.
3. Wait for **Connected over Wi-Fi. You can unplug the USB cable.** before unplugging.
4. Close the panel. Choose **Prepare** if needed, then set a location or start a route normally. Keep Roam open and the computer awake.

If the iPhone does not appear, reconnect USB and enable **Show this iPhone when on Wi-Fi** in Finder (Mac) or **Show this device when on Wi-Fi** in Apple Devices (Windows), then Apply. Unlock the iPhone and refresh Roam. First-time trust still requires a cable; this is not wireless pairing with an untrusted iPhone. iOS 17.4+ is required. [Upstream iPhone network transport guide](https://github.com/doronz88/pymobiledevice3/blob/master/docs/guides/ios17-tunnels.md).

### Android on Mac or Windows

**Already connected over USB (Android 8+):** Prepare the phone normally, put it on the same Wi-Fi network, then click **Switch to Wi-Fi**. Roam reads the phone's Wi-Fi address, enables ADB TCP/IP on port 5555, and verifies the hardware identity before transferring the session. Use a trusted network. Restart the phone to disable this network-debugging mode. [Android's USB-assisted Wi-Fi flow](https://developer.android.com/tools/adb#wireless).

**Without a cable (Android 11+):** Open **Manual setup and troubleshooting** in the connection panel.

1. Android 11+ is required for the cable-free pairing flow. Enable Developer options by tapping Build number seven times. Enable **Wireless debugging** while on the same Wi-Fi as your computer.
2. In Roam's connection panel choose **Wi-Fi**, then **Android**.
3. On the phone, open **Pair device with pairing code**. Enter its IP address, pairing port and six-digit code in Roam; click **Pair phone**. Roam does not save the code.
4. Return to the phone's main **Wireless debugging** screen. Enter that screen's IP address and **connection port** in Roam, then click **Connect paired phone**. The connection port differs from the pairing port.
5. Close the panel, select your phone and click **Prepare** if needed. Keep Location on; select Appium Settings as the mock location app. Set a pin or start a route as usual.

If the connection drops, check Wireless debugging and reconnect with its current IP address and port. ADB may also reconnect through its local discovery. Roam checks the phone's hardware serial so a changed port stays the same phone. For a USB-assisted connection, reconnect USB and use Switch to Wi-Fi again if the address changes. [Android wireless debugging guide](https://developer.android.com/tools/adb#wireless-android11-command-line).

### Wi-Fi troubleshooting and verification

Allow Roam and its bundled device tools through local-network/firewall prompts. Guest networks, client isolation and VPNs can block local discovery. Use the same ordinary Wi-Fi network for both devices. To remove trust later, forget the computer in Android's Wireless debugging settings, or disable Wi-Fi visibility in Finder/Apple Devices for iPhone.

Routes request updates every second at the speed you chose. A slow Wi-Fi connection no longer pauses a route: points go out as fast as the phone accepts them and the position stays true to elapsed time. A lost connection holds movement, and the route **resumes automatically** when the same phone reconnects. Fixed iPhone locations keep the one-second acknowledged refresh loop; Android's helper refreshes a fixed location every two seconds. Restore before disconnecting. Wi-Fi loss, sleep or a closed app cannot guarantee immediate restoration; reconnect the phone and use Restore, or restart it.

Mac → iPhone over Wi-Fi was **verified end to end on a physical phone on 2026-10-21**, including the fix for phones whose Wi-Fi address rotates (iOS private Wi-Fi address): Roam matches the phone by its identity, not its current network address. Other host/phone combinations have automated adapter, transport-selection, pairing, identity, refresh and UI coverage but have not all been run on physical hardware.
