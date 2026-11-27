# Privacy policy

Effective 27 November 2026.

This policy covers the Agaric app on Linux, Windows, macOS and Android.

## In short

- **No account, no telemetry, no analytics, no ads.** The maintainer runs no server, and the app sends nothing to the maintainer.
- **Your notes stay on your devices.** They live in a database on each device and sync only between devices you pair yourself. Nothing else receives them unless you connect an AI agent.
- **A few features reach the internet.** Each is listed below, with what it sends and to whom.

## What Agaric keeps on your device

Your notes, their attachments (voice notes included), the history of every change, a daily copy of the database and the app's log are kept in the data folder:

| System | Data folder |
| --- | --- |
| Linux | `~/.local/share/com.agaric.app/` (under `$XDG_DATA_HOME` when set) |
| macOS | `~/Library/Application Support/com.agaric.app/` |
| Windows | `%APPDATA%\com.agaric.app\` |
| Android | `/data/data/com.agaric.app/`, private to the app |

On desktop, *Settings › Data › Daily snapshot › Open folder* opens it.

Interface preferences, such as the theme, are kept by the system's web view: inside the data folder on Linux and Android, in `%LOCALAPPDATA%\com.agaric.app\` on Windows, and in `~/Library/WebKit/com.agaric.app/` on macOS.

Agaric does not encrypt the database itself; your system's disk encryption (FileVault, BitLocker, LUKS, Android's own) protects it.

On Android, the data is excluded from cloud backup and from phone-to-phone transfer, so no copy of your notes reaches Google's backup. A new phone gets your notes by pairing with one of your devices.

## What leaves your device, and when

### Sync with your own devices

Devices you pair sync directly with each other over your local network, encrypted. To find each other, they announce themselves on that network with random identifiers and their network address; anyone on the same network can see the announcement, but not your notes.

### The internet fallback (off unless you turn it on)

With *Local network, with an internet fallback* on, on both devices (Settings › Sync & devices), sync goes through a relay server run by iroh's maintainers (n0) whenever the direct path fails. The relay forwards encrypted traffic it cannot read, but it sees which of your devices are talking, from which addresses, when, and how much data moves. While sync runs, the device keeps a connection to it.

### Checking for updates

At most once a day, and whenever you press *Check for updates now* (Settings › About), the desktop app asks GitHub whether a newer release exists, and downloads it from GitHub if you choose to install it. The Android app asks the same question at most once a day and only tells you; you install the new version yourself. A copy installed from Flathub, the Snap Store, the Microsoft Store or the AUR does not check, because that store or package manager delivers its updates.

The request contains no notes and no identifier. Like any download, it shows GitHub your IP address and the time.

### Link previews

When you paste or insert a web link, Agaric fetches that page from its site, once, to show its title and description. Hovering over or focusing a link fetches it too, unless you turn off *Fetch link previews on hover* (Settings › Editor). Either way the site sees your IP address and a request from Agaric for that page.

### Images from other websites

An image in a note that points to another website, and the icon of a link preview, load only as *Settings › Editor › External images* allows: by default Agaric asks each time. Loading one tells that site you opened the page.

### Bug reports

Only when you choose *Report a bug* (Settings › About, or on an error screen). The dialog shows exactly what the report contains: your title and description, the app version, the operating system, a shortened device identifier, a few internal counts, and recent error lines from the log with personal details replaced by placeholders. Its GitHub button opens a prefilled issue in your browser; nothing is sent until you submit it there, and GitHub issues are public. If you include logs, they are saved as a ZIP file on your device for you to attach yourself.

### AI agents (MCP)

Off unless you turn it on, and desktop only (Settings › Agent access). Agents connect through a local socket on your computer, never a network port. Each agent has its own token, is read-only or read-write, and reaches only the spaces you choose. What an agent does with what it reads is up to that agent: an AI assistant usually sends it to its provider, under that provider's privacy policy.

### Reading aloud

*Read aloud* hands the text to your system's speech engine. Whether that engine works offline depends on your system and the voice you chose.

## Microphone, camera and notifications

- **Microphone:** only while you record a voice note. The recording is saved as an attachment in your notes and syncs to your paired devices like any other attachment.
- **Camera:** only while you scan a pairing QR code. The image is read on the device and not kept.
- **Notifications:** task reminders on desktop, made on your device from your own notes. No push service is involved.

## Deleting your data

- **On one device:** quit Agaric and delete its data folder, and on Windows and macOS the web view's preferences folder (both above). On Android, uninstalling deletes it. On Windows, the `-setup.exe` uninstaller offers *Delete the application data*. On Linux and macOS, uninstalling leaves the folder, so delete it yourself.
- **On your other devices:** your paired devices keep their own copy; delete it on each one.
- **Files you made:** exports, a Markdown mirror folder and saved bug-report ZIPs are ordinary files you manage.
- **Bug reports you submitted** are on GitHub; delete or edit them there.

## Third parties

- **GitHub** hosts the downloads, the releases, the update check and the issues. [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) covers what it sees.
- **The iroh relay**, run by n0, only while the internet fallback is on.
- **Websites your notes link to**, for link previews and images.
- **An app store**, if you install Agaric from one: its own privacy policy covers the download and the updates it delivers.

## Changes

Changes to this policy are made in this file, and its history on GitHub keeps every earlier version.

## Contact

Questions about this policy: open an issue at <https://github.com/jfolcini/agaric/issues>. Security matters: follow [SECURITY.md](SECURITY.md), which explains how to report privately.
