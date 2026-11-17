# Maple Tracker

EXP, mesos and items per hour for MapleStory Classic. It reads the numbers
off a stream of the game (Discord, YouTube, Twitch) and never touches the game
itself. Shows EXP/hour, your recent pace, level, % and time to next level.

> [!WARNING]
> **Run this on a second device, not the PC you play on.** Nexon's rules can
> treat screen-reading programs running alongside the game as unauthorized
> third-party programs, even ones that never touch the game. Your gaming PC
> should run only MapleStory and Discord. A second PC, laptop or Mac watches
> your Discord stream and runs Maple Tracker.

## Download

| | |
|---|---|
| **Windows** | **[MapleTracker.zip](../../releases/latest/download/MapleTracker.zip)** |
| **Mac** (Apple Silicon, M1 or newer) | **[MapleTracker-mac.zip](../../releases/latest/download/MapleTracker-mac.zip)** |

**Windows:** unzip, double-click `MapleTracker.exe`. If Windows says "Windows
protected your PC", click **More info**, then **Run anyway**.

**Mac:** unzip and open the app. When macOS says it can't verify it, go to
**System Settings > Privacy & Security** and click **Open Anyway**. Then allow
it under **Screen & System Audio Recording** and reopen it.

Then put the stream on screen with the game's bottom bar visible and click
**Start**. There's nothing to calibrate: it finds the HUD by itself, reads the
EXP numbers, and finds them again if the window moves. If your HUD shows only a
percentage (like `EXP. [65.99%]`), it asks for your level once and converts %
to EXP with the official EXP table. `README.txt` inside the download has the
full guide.

You can watch your stats on the gaming PC too: open the web address shown at
the bottom of the tracker in a browser.

## How it's built

Every change to this repository is built automatically on GitHub's Windows
and Mac servers (see the **Actions** tab). Each build runs a self-test that
proves the packaged app can read text before it's published under
**Releases**. The download links above always point to the newest build.
