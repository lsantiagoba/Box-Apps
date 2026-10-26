# Box Apps

<p align="center"><img src="assets/box-apps.png" width="128" alt="Box Apps icon"></p>

A GNOME Shell extension that puts your App Grid folders in the Dash or the Ubuntu Dock. Each folder shows a 2×2 preview of its apps. Click it to open its apps in a popup.

## Features

- **Folders in the dock:** Pick which folders to show. The default is the App Grid's "Utilities" folder.
- **Your own folders:** Make folders in the preferences and choose any apps for them. Rename them, reorder their apps, or delete them at any time.
- **App Grid folders:** Box Apps also reads the folders GNOME already has. Rename a folder or add and remove apps in the App Grid, and the dock updates right away.
- **Place folders anywhere:** Drag a folder along the dock and drop it between any two apps. It stays next to that app, even after restarts. Folders that are not placed go at the end of the dock.
- **Popup grid:** Click a folder to see its apps in a grid next to the dock. Click an app to open it.
- **Right-click menu:** Open the folder, move it back to the end of the dock, remove it from the dock, or open the settings.
- **Works with your dock:** Supports Ubuntu Dock and Dash to Dock on any screen edge, with one set of folders per dock. Without a dock extension, the folders go in the overview Dash.
- **Settings:** Separator line, popup columns, and whether apps already pinned to the dock are left out of App Grid folders (like the App Grid does).

To create an App Grid folder, open the App Grid and drag one app onto another.

## Supported GNOME Shell Versions

- GNOME 45
- GNOME 46
- GNOME 47
- GNOME 48
- GNOME 49
- GNOME 50

## Installation

### From Source

1. Clone this repository to your local machine:
   ```bash
   git clone https://github.com/lsantiagoba/box-apps.git
   cd box-apps
   ```

2. Run the provided installation script:
   ```bash
   # Debian/Ubuntu: sudo apt install gettext libglib2.0-bin
   ./install.sh
   ```

3. Restart GNOME Shell:
   - **X11:** Press `Alt` + `F2`, type `r`, and press `Enter`.
   - **Wayland:** Log out and log back in.

4. Enable the extension:
   ```bash
   gnome-extensions enable box-apps@lsantiagoba
   ```

5. Open the preferences and turn on the folders you want in the dock.

## Uninstallation

```bash
./uninstall.sh
```

This removes the extension and its settings. Your App Grid folders are never touched.

## Packaging

```bash
./pack-extension.sh
```

Creates `box-apps@lsantiagoba.zip` for upload to https://extensions.gnome.org.

## How It Works

Ubuntu Dock and Dash to Dock export their `dockManager` for other extensions. Box Apps uses it to find each dock and puts the folder icons inside the dock's own icon box, so they can sit between any apps.

The dock's code counts the icons in that box to decide where new icons and dropped apps go. Box Apps gives the box its own `get_children()`, `insert_child_at_index()` and `set_child_at_index()` that leave the folders out of that count, so pinning, reordering and running-app dots keep working as before. When a dock is rebuilt (for example after changing its settings or plugging in a monitor), the folders are added again.

## Project Layout

```
src/v45-46-47-48-49-50/
├── extension.js       Finds the docks and saves folder changes
├── DashFolders.js     Places the folder icons inside one dock and handles dragging
├── DockFolder.js      One folder icon, with its label, popup and right-click menu
├── FolderStore.js     Reads App Grid and custom folders and watches them for changes
├── folders.js         Folder helpers shared with the preferences window
├── prefs.js           Preferences window
├── stylesheet.css
├── metadata.json
└── schemas/           GSettings schema
po/                    Translations (Spanish included)
assets/                Icon (SVG source and PNG exports)
```

## License

Box Apps is free software, released under the [GNU General Public License v3.0 or later](LICENSE). You can use, study, share and change it. If you share a changed version, it must use the same license.
