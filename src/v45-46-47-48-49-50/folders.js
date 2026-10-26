import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Helpers for reading the App Grid folders. They only use Gio and GLib, so
// both the extension and the preferences window can import them.

const FOLDERS_SCHEMA = 'org.gnome.desktop.app-folders';
const FOLDER_SCHEMA = 'org.gnome.desktop.app-folders.folder';
const FOLDERS_PATH = '/org/gnome/desktop/app-folders/folders/';

// Folders made in the preferences use keys with this prefix. App Grid
// folders use their plain folder ID as key.
export const CUSTOM_PREFIX = 'custom:';

export const isCustomKey = key => key.startsWith(CUSTOM_PREFIX);

// Custom folders are stored as a JSON list of {id, name, apps}. A broken
// value is treated as no folders rather than breaking the extension.
export const readCustomFolders = settings => {
    try {
        const folders = JSON.parse(settings.get_string('custom-folders'));
        if (!Array.isArray(folders))
            return [];
        return folders
            .filter(folder => typeof folder?.id === 'string' && isCustomKey(folder.id))
            .map(folder => ({
                id: folder.id,
                name: typeof folder.name === 'string' ? folder.name : '',
                apps: Array.isArray(folder.apps)
                    ? folder.apps.filter(app => typeof app === 'string') : [],
            }));
    } catch (e) {
        return [];
    }
};

export const writeCustomFolders = (settings, folders) => {
    settings.set_string('custom-folders', JSON.stringify(folders));
};

export const newCustomKey = () => `${CUSTOM_PREFIX}${GLib.uuid_string_random().slice(0, 8)}`;

export const newFoldersSettings = () => new Gio.Settings({schema_id: FOLDERS_SCHEMA});

export const newFolderSettings = id => new Gio.Settings({
    schema_id: FOLDER_SCHEMA,
    path: `${FOLDERS_PATH}${id}/`,
});

export const listFolderIds = foldersSettings => foldersSettings.get_strv('folder-children');

// Folders created by GNOME store a .directory file name (for example
// "Utilities.directory") and set translate=true. The shown name then comes
// from that file, in the user's language. Same rule as the App Grid.
const translatedDirectoryName = directory => {
    const dirs = [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()];
    for (const dir of dirs) {
        const path = GLib.build_filenamev([dir, 'desktop-directories', directory]);
        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            continue;

        try {
            const keyFile = new GLib.KeyFile();
            keyFile.load_from_file(path, GLib.KeyFileFlags.NONE);
            return keyFile.get_locale_string('Desktop Entry', 'Name', null);
        } catch (e) {
            return null;
        }
    }
    return null;
};

export const folderName = folderSettings => {
    const name = folderSettings.get_string('name');
    if (folderSettings.get_boolean('translate'))
        return translatedDirectoryName(name) ?? name;
    return name;
};

const appCategories = appInfo => (appInfo.get_categories() ?? '')
    .split(';')
    .filter(category => category.length > 0);

// App IDs inside a folder, in the same order the App Grid uses: first the
// apps added by hand, then installed apps whose category matches the folder.
// appInfos is the list of installed Gio.AppInfo objects.
export const folderAppIds = (folderSettings, appInfos) => {
    const excluded = new Set(folderSettings.get_strv('excluded-apps'));
    const ids = [];
    const add = id => {
        if (!excluded.has(id) && !ids.includes(id))
            ids.push(id);
    };

    folderSettings.get_strv('apps').forEach(add);

    const categories = folderSettings.get_strv('categories');
    if (categories.length > 0) {
        for (const appInfo of appInfos) {
            if (appInfo.should_show() && appCategories(appInfo).some(category => categories.includes(category)))
                add(appInfo.get_id());
        }
    }

    return ids;
};
