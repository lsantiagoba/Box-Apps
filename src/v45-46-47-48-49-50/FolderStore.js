import Shell from 'gi://Shell';

import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';

import {
    folderAppIds,
    folderName,
    isCustomKey,
    listFolderIds,
    newFolderSettings,
    newFoldersSettings,
    readCustomFolders,
} from './folders.js';

// Reads the App Grid folders and the custom folders, and tells its owner when
// anything that changes their contents happens: a folder is added, renamed or
// edited, an app is installed or removed, or the favorites change.
export class FolderStore {
    constructor(settings, onChanged) {
        this._settings = settings;
        this._onChanged = onChanged;
        this._appSystem = Shell.AppSystem.get_default();
        this._foldersSettings = newFoldersSettings();
        this._folderSettings = new Map();

        this._foldersSettings.connectObject('changed::folder-children', () => {
            this._watchFolders();
            this._onChanged();
        }, this);
        this._appSystem.connectObject('installed-changed', () => this._onChanged(), this);
        AppFavorites.getAppFavorites().connectObject('changed', () => this._onChanged(), this);

        this._watchFolders();
    }

    destroy() {
        this._foldersSettings.disconnectObject(this);
        this._appSystem.disconnectObject(this);
        AppFavorites.getAppFavorites().disconnectObject(this);
        for (const folder of this._folderSettings.values())
            folder.disconnectObject(this);
        this._folderSettings.clear();
        this._onChanged = null;
    }

    // Keeps one settings object per App Grid folder, so edits made in the App
    // Grid (renaming, adding or removing apps) update the dock right away.
    _watchFolders() {
        const ids = listFolderIds(this._foldersSettings);

        for (const [id, folder] of this._folderSettings) {
            if (!ids.includes(id)) {
                folder.disconnectObject(this);
                this._folderSettings.delete(id);
            }
        }

        for (const id of ids) {
            if (this._folderSettings.has(id))
                continue;
            const folder = newFolderSettings(id);
            folder.connectObject('changed', () => this._onChanged(), this);
            this._folderSettings.set(id, folder);
        }
    }

    _lookupApps(appIds) {
        return appIds
            .map(appId => this._appSystem.lookup_app(appId))
            .filter(app => app !== null);
    }

    // Returns {key, name, apps} for a folder key, or null if there is no such
    // folder. apps holds the Shell.App objects shown inside the folder.
    getFolder(key) {
        if (isCustomKey(key)) {
            const custom = readCustomFolders(this._settings).find(folder => folder.id === key);
            if (!custom)
                return null;
            return {key, name: custom.name, apps: this._lookupApps(custom.apps)};
        }

        const folder = this._folderSettings.get(key);
        if (!folder)
            return null;

        const favorites = AppFavorites.getAppFavorites();
        const hideFavorites = this._settings.get_boolean('hide-favorites');
        const appIds = folderAppIds(folder, this._appSystem.get_installed())
            .filter(appId => !hideFavorites || !favorites.isFavorite(appId));

        return {key, name: folderName(folder), apps: this._lookupApps(appIds)};
    }
}
