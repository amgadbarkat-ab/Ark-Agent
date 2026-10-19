# Desktop icons

These are ArkAgent's icons, made from the character's portrait (`brand/arkagent/icon-source.webp`; see
[`brand/README.md`](../../../brand/README.md)). Nothing here is drawn by hand.

`icon.png` is the 1024×1024 master: the character's head in a rounded square with a margin of 2% of the width on
every side and transparent corners. It is written by `brand/render-icons.mjs`. Every other file in this folder is
made from it by Tauri's own icon command, which knows each platform's formats and sizes:

```sh
# from the repository root
PLAYWRIGHT_MODULE=… CHROMIUM_PATH=… node brand/render-icons.mjs   # writes desktop/src-tauri/icons/icon.png
cd desktop
bun run tauri icon src-tauri/icons/icon.png --output /tmp/ark-icons   # a fresh, empty directory
for file in /tmp/ark-icons/*; do
  [ -f "$file" ] && [ "$(basename "$file")" != icon.png ] && cp "$file" src-tauri/icons/
done
```

Keep the master as the direct render: the command also writes a lower-resolution `icon.png`, which must
not replace it. Its `android/` and `ios/` folders are not used here (the phone apps have their own icons,
`mobile/README.md`).

What uses what:

- `icon.ico` (Windows installer and window), `icon.icns` (macOS), `32x32.png`, `128x128.png` and
  `128x128@2x.png` (Linux) are listed in `tauri.conf.json`.
- `64x64.png` is the tray icon on every platform (`src/tray.rs` embeds it). Its test checks that the
  corners are transparent and that the ember and the bars are both there, so a blank or flat icon cannot
  ship.
- The `Square…Logo.png` and `StoreLogo.png` files are for a Microsoft Store package, which this project
  does not publish. They are kept so the set stays whole.

The macOS `.icns` and the Windows `.ico` were generated here but have not been looked at on a Mac or a
Windows machine. Look at the installed app's icon on each before a release.
