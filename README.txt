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
3. Continue with "Calibrate" below.


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
4. Continue with "Calibrate" below.


CALIBRATE
---------
1. Put the Discord stream on screen, fullscreen, and click Calibrate in
   the tracker window. Move your mouse onto that screen.
2. After a 5-second countdown you'll see a screenshot. Drag boxes around:
     - the EXP numbers on the bottom bar, e.g. 12345[12.34%]  (needed)
     - the meso total in your inventory window                 (optional)
     - the area where "You have gained..." messages show up    (optional)
   Draw each box tightly around the text, then press Enter (or Confirm).
3. The app then shows what it read. The numbers should match the game.
   If not, open the menu (gear icon) > Calibrate and try tighter boxes.
4. Click Start and go grind. Drag the tracker window anywhere, as long
   as it isn't covering one of the boxes you drew.


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
- Calibrate again if you change game resolution, stream quality or
  monitors.
- Menu: click the gear icon, or right-click the tracker (Control-click on
  Mac): Calibrate, Check reading, Open data folder, Quit.
- Settings, session logs (sessions folder) and tracker.log are saved:
    Windows: next to MapleTracker.exe (or %APPDATA%\MapleTracker)
    Mac:     ~/Library/Application Support/MapleTracker
- If something breaks, send tracker.log to whoever gave you the app.
