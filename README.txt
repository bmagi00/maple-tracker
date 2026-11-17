MAPLE TRACKER
EXP, mesos and items per hour for MapleStory Classic
=====================================================

!! IMPORTANT: RUN THIS ON A SECOND DEVICE, NOT THE PC YOU PLAY ON !!

Nexon's rules can treat programs that read the screen as "unauthorized
third-party programs" when they run on the same PC as the game, even ones
like this that never touch the game. Running it there could get your
account banned.

Safe setup:
  - Gaming PC: runs only MapleStory and Discord. Go Live with the game.
  - Second PC, laptop or Mac: watches that Discord stream and runs
    Maple Tracker.
You can still see your stats on the gaming PC by opening the tracker's
web address in a browser (see "See your stats on another device").


GETTING STARTED (WINDOWS)
-------------------------
1. Unzip the whole MapleTracker folder somewhere, e.g. your Desktop.
   Keep all the files together - the app needs them.
2. Double-click MapleTracker.exe.
   Windows may say "Windows protected your PC" because the app isn't
   signed by a company. Click "More info", then "Run anyway".
3. Continue with "Start tracking" below.


GETTING STARTED (MAC - Apple Silicon, M1 or newer)
--------------------------------------------------
1. Unzip MapleTracker-mac.zip and drag MapleTracker into Applications
   (or anywhere you like).
2. Double-click it. macOS will say it can't verify the app because it
   isn't from an identified developer. Click Done, then open
   System Settings > Privacy & Security, scroll down and click
   "Open Anyway" next to MapleTracker. Confirm, and it opens.
3. The app asks for permission to read your screen. Open
   System Settings > Privacy & Security > Screen & System Audio Recording
   (Screen Recording on older macOS), turn on MapleTracker, then quit
   and reopen it.
4. Continue with "Start tracking" below.


START TRACKING
--------------
1. Put the stream on screen (fullscreen is best) so the game's bottom bar
   is visible: LV, HP, MP and EXP. No setup or boxes needed.
2. Click Start. The tracker finds the bar by itself (look for "Lv ..
   ..%" under EXP / HR). If the stream window moves, it finds it again.
3. If your HUD only shows a percentage, like EXP. [65.99%], it asks for
   your level once. It turns % into EXP with the official EXP table and
   counts level-ups from there. If it ever gets out of sync, use
   menu > Set my level.
4. Optional: menu > Check reading shows exactly what it read. It should
   match the game.

The tracker reads the game's digits by comparing them with examples of
the HUD font, and keeps learning from your stream, so it gets more sure
of itself over the first few minutes. If it isn't sure about a digit it
skips that reading instead of guessing.

ADVANCED: menu > Draw boxes myself lets you mark the meso total and
pickup messages (optional), or the EXP numbers if automatic finding
doesn't work for your layout.


WATCHING THE DISCORD STREAM
---------------------------
- On your gaming PC, Go Live with just the game window, at the best
  quality you have.
- On the second device, open the stream, pop it out and make it
  fullscreen.
- Keep the mouse off the stream. Discord's controls cover the bottom of
  the video, which is where the EXP bar is.
- Don't minimize the stream.


SEE YOUR STATS ON ANOTHER DEVICE
--------------------------------
The bottom of the tracker shows an address like http://192.168.1.50:8765
Open it in a browser on any PC or phone on the same Wi-Fi - including
your gaming PC, since that's just a web page. You can start, pause and
reset from there too.
The first time, Windows or macOS will ask whether to allow MapleTracker
on the network. Allow it (on Windows: Private networks).


GOOD TO KNOW
------------
- Per-hour numbers show up after the first minute.
- Per-hour shows the whole session; "now" is your pace over the last
  5 minutes. "Next level in" uses that pace.
- Menu: click the gear icon, or right-click the tracker (Control-click on
  Mac): Check reading, Find the HUD again, Set my level, Draw boxes
  myself, Open data folder, Quit.
- Settings, session logs (sessions folder) and tracker.log are saved:
    Windows: next to MapleTracker.exe (or %APPDATA%\MapleTracker)
    Mac:     ~/Library/Application Support/MapleTracker
- If something breaks, send tracker.log to whoever gave you the app.
