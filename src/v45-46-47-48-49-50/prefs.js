import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import {
    ExtensionPreferences,
    gettext as _,
    ngettext,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    folderAppIds,
    folderName,
    listFolderIds,
    newCustomKey,
    newFolderSettings,
    newFoldersSettings,
    readCustomFolders,
    writeCustomFolders,
} from './folders.js';

const flatButton = (iconName, tooltip) => new Gtk.Button({
    icon_name: iconName,
    tooltip_text: tooltip,
    valign: Gtk.Align.CENTER,
    css_classes: ['flat'],
});

// Removes every row added to a group earlier, before the group is rebuilt.
const clearRows = (group, rows) => {
    rows.splice(0).forEach(row => group.remove(row));
};

const appCountLabel = count => ngettext('%d app', '%d apps', count).replace('%d', count);

// Apps that show up in the App Grid, sorted by name.
const visibleApps = () => Gio.AppInfo.get_all()
    .filter(appInfo => appInfo.should_show())
    .sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()));

const appIcon = appInfo => {
    const icon = new Gtk.Image({pixel_size: 32});
    const gicon = appInfo?.get_icon();
    if (gicon)
        icon.set_from_gicon(gicon);
    else
        icon.set_from_icon_name('application-x-executable');
    return icon;
};

// A window listing every app with a check box. onDone receives the IDs of
// the apps that were checked. Apps in "selected" start checked.
const pickApps = (parent, title, selected, onDone) => {
    const window = new Adw.Window({
        title,
        modal: true,
        transient_for: parent,
        default_width: 420,
        default_height: 560,
    });

    const chosen = new Set(selected);
    const header = new Adw.HeaderBar({show_end_title_buttons: false, show_start_title_buttons: false});
    const cancel = new Gtk.Button({label: _('Cancel')});
    cancel.connect('clicked', () => window.close());
    const done = new Gtk.Button({label: _('Done'), css_classes: ['suggested-action']});
    done.connect('clicked', () => {
        onDone([...chosen]);
        window.close();
    });
    header.pack_start(cancel);
    header.pack_end(done);

    const search = new Gtk.SearchEntry({
        placeholder_text: _('Search apps'),
        margin_start: 12,
        margin_end: 12,
        margin_top: 6,
        margin_bottom: 6,
    });

    const list = new Gtk.ListBox({
        selection_mode: Gtk.SelectionMode.NONE,
        css_classes: ['boxed-list'],
        margin_start: 12,
        margin_end: 12,
        margin_bottom: 12,
    });

    for (const appInfo of visibleApps()) {
        const id = appInfo.get_id();
        const row = new Adw.ActionRow({title: appInfo.get_display_name(), use_markup: false});
        row.add_prefix(appIcon(appInfo));
        const check = new Gtk.CheckButton({active: chosen.has(id), valign: Gtk.Align.CENTER});
        check.connect('toggled', () => {
            if (check.active)
                chosen.add(id);
            else
                chosen.delete(id);
        });
        row.add_suffix(check);
        row.activatable_widget = check;
        row._searchText = appInfo.get_display_name().toLowerCase();
        list.append(row);
    }

    list.set_filter_func(row => row._searchText.includes(search.text.toLowerCase()));
    search.connect('search-changed', () => list.invalidate_filter());

    const scrolled = new Gtk.ScrolledWindow({
        vexpand: true,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        child: list,
    });

    const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
    content.append(header);
    content.append(search);
    content.append(scrolled);
    window.set_content(content);
    window.present();
};

// Asks for a folder name. onDone receives the trimmed, non-empty name.
const askName = (parent, title, initial, onDone) => {
    const window = new Adw.Window({
        title,
        modal: true,
        transient_for: parent,
        default_width: 360,
    });

    const header = new Adw.HeaderBar({show_end_title_buttons: false, show_start_title_buttons: false});
    const cancel = new Gtk.Button({label: _('Cancel')});
    cancel.connect('clicked', () => window.close());
    const save = new Gtk.Button({label: _('Save'), css_classes: ['suggested-action']});
    header.pack_start(cancel);
    header.pack_end(save);

    const entry = new Gtk.Entry({
        text: initial,
        placeholder_text: _('Folder name'),
        margin_start: 12,
        margin_end: 12,
        margin_top: 12,
        margin_bottom: 12,
        activates_default: true,
    });

    const finish = () => {
        const name = entry.text.trim();
        if (name.length === 0)
            return;
        onDone(name);
        window.close();
    };
    save.connect('clicked', finish);
    entry.connect('activate', finish);

    const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
    content.append(header);
    content.append(entry);
    window.set_content(content);
    window.present();
};

export default class BoxAppsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const shellSettings = new Gio.Settings({schema_id: 'org.gnome.shell'});
        const foldersSettings = newFoldersSettings();

        const page = new Adw.PreferencesPage({
            title: _('Box Apps'),
            icon_name: 'folder-symbolic',
        });
        window.add(page);

        const setShown = (key, show) => {
            const shown = settings.get_strv('dock-folders').filter(other => other !== key);
            if (show)
                shown.push(key);
            settings.set_strv('dock-folders', shown);
        };

        const toggleFor = key => {
            const toggle = new Gtk.Switch({
                active: settings.get_strv('dock-folders').includes(key),
                valign: Gtk.Align.CENTER,
                tooltip_text: _('Show in the dock'),
            });
            toggle.connect('notify::active', () => setShown(key, toggle.active));
            return toggle;
        };

        // Custom folders
        const customGroup = new Adw.PreferencesGroup({
            title: _('Your folders'),
            description: _('Folders you make here can hold any apps you choose.'),
        });
        const addButton = new Gtk.Button({
            child: new Adw.ButtonContent({icon_name: 'list-add-symbolic', label: _('New folder')}),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        customGroup.set_header_suffix(addButton);
        page.add(customGroup);
        const customRows = [];

        const updateCustom = (id, change) => {
            const folders = readCustomFolders(settings);
            const folder = folders.find(other => other.id === id);
            if (!folder)
                return;
            change(folder);
            writeCustomFolders(settings, folders);
        };

        const deleteCustom = id => {
            writeCustomFolders(settings, readCustomFolders(settings).filter(other => other.id !== id));
            setShown(id, false);
            const anchors = settings.get_value('folder-anchors').deep_unpack();
            delete anchors[id];
            settings.set_value('folder-anchors', new GLib.Variant('a{ss}', anchors));
        };

        addButton.connect('clicked', () => {
            askName(window, _('New folder'), '', name => {
                pickApps(window, _('Choose apps'), [], apps => {
                    const folders = readCustomFolders(settings);
                    const id = newCustomKey();
                    folders.push({id, name, apps});
                    writeCustomFolders(settings, folders);
                    setShown(id, true);
                });
            });
        });

        // Remembers which folders were expanded, so editing one does not
        // collapse it when the list is rebuilt.
        const expanded = new Set();

        const rebuildCustom = () => {
            clearRows(customGroup, customRows);
            const folders = readCustomFolders(settings);
            const installed = new Map(Gio.AppInfo.get_all().map(appInfo => [appInfo.get_id(), appInfo]));

            if (folders.length === 0) {
                const row = new Adw.ActionRow({
                    title: _('No folders yet'),
                    subtitle: _('Use “New folder” to make one with the apps you want.'),
                });
                customGroup.add(row);
                customRows.push(row);
                return;
            }

            for (const folder of folders) {
                const row = new Adw.ExpanderRow({
                    title: folder.name,
                    subtitle: appCountLabel(folder.apps.length),
                    use_markup: false,
                    expanded: expanded.has(folder.id),
                });
                row.connect('notify::expanded', () => {
                    if (row.expanded)
                        expanded.add(folder.id);
                    else
                        expanded.delete(folder.id);
                });
                row.add_suffix(toggleFor(folder.id));

                const actions = new Adw.ActionRow({title: _('Edit folder')});
                const addApps = flatButton('list-add-symbolic', _('Choose apps'));
                addApps.connect('clicked', () => {
                    pickApps(window, _('Choose apps'), folder.apps, apps => {
                        updateCustom(folder.id, changed => {
                            // Keep the existing order and add new apps at the end.
                            changed.apps = [
                                ...changed.apps.filter(app => apps.includes(app)),
                                ...apps.filter(app => !changed.apps.includes(app)),
                            ];
                        });
                    });
                });
                const rename = flatButton('document-edit-symbolic', _('Rename'));
                rename.connect('clicked', () => {
                    askName(window, _('Rename folder'), folder.name, name => {
                        updateCustom(folder.id, changed => {
                            changed.name = name;
                        });
                    });
                });
                const remove = flatButton('user-trash-symbolic', _('Delete folder'));
                remove.add_css_class('error');
                remove.connect('clicked', () => deleteCustom(folder.id));
                actions.add_suffix(addApps);
                actions.add_suffix(rename);
                actions.add_suffix(remove);
                row.add_row(actions);

                folder.apps.forEach((appId, index) => {
                    const appInfo = installed.get(appId) ?? null;
                    const appRow = new Adw.ActionRow({
                        title: appInfo?.get_display_name() ?? appId,
                        subtitle: appInfo ? '' : _('Not installed'),
                        use_markup: false,
                    });
                    appRow.add_prefix(appIcon(appInfo));

                    const up = flatButton('go-up-symbolic', _('Move up'));
                    up.sensitive = index > 0;
                    up.connect('clicked', () => updateCustom(folder.id, changed => {
                        changed.apps.splice(index - 1, 0, ...changed.apps.splice(index, 1));
                    }));
                    const down = flatButton('go-down-symbolic', _('Move down'));
                    down.sensitive = index < folder.apps.length - 1;
                    down.connect('clicked', () => updateCustom(folder.id, changed => {
                        changed.apps.splice(index + 1, 0, ...changed.apps.splice(index, 1));
                    }));
                    const drop = flatButton('list-remove-symbolic', _('Remove from folder'));
                    drop.connect('clicked', () => updateCustom(folder.id, changed => {
                        changed.apps.splice(index, 1);
                    }));
                    appRow.add_suffix(up);
                    appRow.add_suffix(down);
                    appRow.add_suffix(drop);
                    row.add_row(appRow);
                });

                customGroup.add(row);
                customRows.push(row);
            }
        };

        // App Grid folders
        const gridGroup = new Adw.PreferencesGroup({
            title: _('App Grid folders'),
            description: _('Folders from the App Grid. Make one there by dragging an app onto another.'),
        });
        page.add(gridGroup);
        const gridRows = [];

        const gridAppCount = folder => {
            const favorites = settings.get_boolean('hide-favorites')
                ? shellSettings.get_strv('favorite-apps') : [];
            const appInfos = Gio.AppInfo.get_all();
            const installed = new Set(appInfos.map(appInfo => appInfo.get_id()));
            return folderAppIds(folder, appInfos)
                .filter(id => installed.has(id) && !favorites.includes(id))
                .length;
        };

        const rebuildGrid = () => {
            clearRows(gridGroup, gridRows);
            const shown = settings.get_strv('dock-folders');

            for (const id of listFolderIds(foldersSettings)) {
                const folder = newFolderSettings(id);
                const count = gridAppCount(folder);

                // The App Grid hides empty folders, so they are only listed
                // here when already turned on.
                if (count === 0 && !shown.includes(id))
                    continue;

                // Folder names are plain text and may contain "&".
                const row = new Adw.ActionRow({
                    title: folderName(folder),
                    subtitle: appCountLabel(count),
                    use_markup: false,
                });
                const toggle = toggleFor(id);
                row.add_suffix(toggle);
                row.activatable_widget = toggle;
                gridGroup.add(row);
                gridRows.push(row);
            }

            if (gridRows.length === 0) {
                const row = new Adw.ActionRow({
                    title: _('No App Grid folders'),
                    subtitle: _('Open the App Grid and drag one app onto another to create a folder.'),
                });
                gridGroup.add(row);
                gridRows.push(row);
            }
        };

        // Appearance
        const appearanceGroup = new Adw.PreferencesGroup({
            title: _('Appearance'),
            description: _('Drag a folder along the dock to place it between any apps.'),
        });
        page.add(appearanceGroup);

        const separatorRow = new Adw.SwitchRow({
            title: _('Separator'),
            subtitle: _('Draw a line before folders at the end of the dock'),
        });
        settings.bind('show-separator', separatorRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        appearanceGroup.add(separatorRow);

        const columnsRow = Adw.SpinRow.new_with_range(2, 8, 1);
        columnsRow.title = _('Popup columns');
        columnsRow.subtitle = _('Apps per row when a folder is opened');
        settings.bind('popup-columns', columnsRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        appearanceGroup.add(columnsRow);

        const favoritesRow = new Adw.SwitchRow({
            title: _('Hide pinned apps in App Grid folders'),
            subtitle: _('Like the App Grid, leave out apps already pinned to the dock'),
        });
        settings.bind('hide-favorites', favoritesRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        appearanceGroup.add(favoritesRow);

        const resetRow = new Adw.ActionRow({
            title: _('Reset positions'),
            subtitle: _('Move every folder back to the end of the dock'),
        });
        const resetButton = new Gtk.Button({label: _('Reset'), valign: Gtk.Align.CENTER});
        resetButton.connect('clicked', () => settings.reset('folder-anchors'));
        resetRow.add_suffix(resetButton);
        appearanceGroup.add(resetRow);

        // Keep the lists in sync with changes made here, in the dock and in
        // the App Grid.
        const rebuildAll = () => {
            rebuildCustom();
            rebuildGrid();
        };
        const ids = [
            settings.connect('changed::dock-folders', rebuildAll),
            settings.connect('changed::custom-folders', rebuildCustom),
            settings.connect('changed::hide-favorites', rebuildGrid),
        ];
        const folderIds = [foldersSettings.connect('changed::folder-children', rebuildGrid)];
        const shellIds = [shellSettings.connect('changed::favorite-apps', rebuildGrid)];

        window.connect('close-request', () => {
            ids.forEach(id => settings.disconnect(id));
            folderIds.forEach(id => foldersSettings.disconnect(id));
            shellIds.forEach(id => shellSettings.disconnect(id));
        });

        rebuildAll();
    }
}
