import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ExtensionState } from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { DashFolders } from './DashFolders.js';
import { FolderStore } from './FolderStore.js';

// Docks that export their DockManager for other extensions. Dash to Dock is
// checked first: when it is enabled, Ubuntu Dock steps aside.
const DOCK_UUIDS = ['dash-to-dock@micxgx.gmail.com', 'ubuntu-dock@ubuntu.com'];
// GNOME 45 calls the "running" state ENABLED, later versions call it ACTIVE.
const STATE_ACTIVE = ExtensionState.ACTIVE ?? ExtensionState.ENABLED;

export default class BoxAppsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        // One DashFolders per dash we added folders to.
        this._dashes = new Map();
        this._dockManager = null;
        this._dockManagerIds = [];
        this._dockSearchId = 0;
        this._rebuildId = 0;

        this._store = new FolderStore(this._settings, () => this._queueRebuild());
        this._settings.connectObject(
            'changed::folder-anchors', () => this._placeAll(),
            'changed::dock-folders', () => this._queueRebuild(),
            'changed::custom-folders', () => this._queueRebuild(),
            'changed::popup-columns', () => this._queueRebuild(),
            'changed::hide-favorites', () => this._queueRebuild(),
            'changed::show-separator', () => this._placeAll(),
            this);
        Main.extensionManager.connectObject('extension-state-changed', (_manager, extension) => {
            if (DOCK_UUIDS.includes(extension.uuid))
                this._findDock();
        }, this);

        this._findDock();
    }

    disable() {
        // Makes any dock search still running ignore its result.
        this._dockSearchId++;

        if (this._rebuildId) {
            GLib.source_remove(this._rebuildId);
            this._rebuildId = 0;
        }

        Main.extensionManager.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._setDockManager(null, false);
        this._detachAll();

        this._store.destroy();
        this._store = null;
        this._dashes = null;
        this._settings = null;
    }

    // Looks for a running Ubuntu Dock or Dash to Dock. Both export their
    // DockManager from extension.js; importing that file again returns the
    // module already loaded by GNOME Shell, not a second copy.
    async _findDock() {
        const searchId = ++this._dockSearchId;
        let manager = null;

        for (const uuid of DOCK_UUIDS) {
            const dock = Main.extensionManager.lookup(uuid);
            if (dock?.state !== STATE_ACTIVE)
                continue;

            try {
                const module = await import(dock.dir.get_child('extension.js').get_uri());
                manager = module.dockManager ?? null;
            } catch (e) {
                logError(e, `Box Apps: cannot reach ${uuid}`);
            }

            if (manager)
                break;
        }

        if (searchId !== this._dockSearchId)
            return;

        this._setDockManager(manager, true);
    }

    _setDockManager(manager, attach) {
        if (this._dockManager !== manager) {
            this._dockManagerIds.forEach(id => this._dockManager.disconnect(id));
            this._dockManagerIds = [];
            this._dockManager = manager;

            // Docks are destroyed and created again when their settings or
            // the monitors change, so folders are added again each time.
            if (manager) {
                this._dockManagerIds = [
                    manager.connect('docks-ready', () => this._attachAll()),
                    manager.connect('docks-destroyed', () => this._detachAll()),
                ];
            }
        }

        if (attach)
            this._attachAll();
    }

    // The dashes to show folders in: one per dock, or the overview Dash when
    // no dock extension is running.
    _targetDashes() {
        if (!this._dockManager)
            return Main.overview.dash ? [Main.overview.dash] : [];

        const docks = this._dockManager.constructor.allDocks ??
            this._dockManager._allDocks ?? [];
        return docks.map(dock => dock.dash).filter(dash => dash?._box);
    }

    _attachAll() {
        const targets = this._targetDashes();

        for (const dash of [...this._dashes.keys()]) {
            if (!targets.includes(dash))
                this._detach(dash);
        }

        for (const dash of targets) {
            if (!this._dashes.has(dash))
                this._attach(dash);
        }
    }

    _detachAll() {
        for (const dash of [...this._dashes.keys()])
            this._detach(dash);
    }

    _attach(dash) {
        const folders = new DashFolders(dash, {
            store: this._store,
            settings: this._settings,
            onRemove: key => this._removeFolder(key),
            onResetPosition: key => this._setAnchor(key, null),
            onSaveDrop: (key, anchor, order) => this._saveDrop(key, anchor, order),
            openPreferences: () => this.openPreferences(),
            onDashDestroyed: () => this._dashes?.delete(dash),
        });
        this._dashes.set(dash, folders);
    }

    _detach(dash) {
        const folders = this._dashes.get(dash);
        if (!folders)
            return;

        this._dashes.delete(dash);
        folders.destroy();
    }

    _queueRebuild() {
        if (this._rebuildId)
            return;

        this._rebuildId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._rebuildId = 0;
            for (const folders of this._dashes.values())
                folders.rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    _placeAll() {
        for (const folders of this._dashes.values())
            folders.place();
    }

    _removeFolder(key) {
        const shown = this._settings.get_strv('dock-folders').filter(other => other !== key);
        this._settings.set_strv('dock-folders', shown);
        this._setAnchor(key, null);
    }

    // anchor: the pinned app the folder follows, '' for the start of the dock,
    // or null for the end of the dock.
    _setAnchor(key, anchor) {
        const anchors = this._settings.get_value('folder-anchors').deep_unpack();
        if (anchor === null)
            delete anchors[key];
        else
            anchors[key] = anchor;
        this._settings.set_value('folder-anchors', new GLib.Variant('a{ss}', anchors));
    }

    // Saves where a dragged folder was dropped. order is the order the
    // folders now have in the dock; it decides which comes first when several
    // folders follow the same app.
    _saveDrop(key, anchor, order) {
        const shown = this._settings.get_strv('dock-folders');
        const rest = shown.filter(other => !order.includes(other));
        const newOrder = [...order, ...rest];
        if (newOrder.join('\n') !== shown.join('\n'))
            this._settings.set_strv('dock-folders', newOrder);

        this._setAnchor(key, anchor);
    }
}
