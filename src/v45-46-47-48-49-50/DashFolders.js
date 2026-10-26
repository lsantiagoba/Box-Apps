import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';

import { DockFolder } from './DockFolder.js';

const isHorizontalSide = side => side === St.Side.TOP || side === St.Side.BOTTOM;

const isOurs = actor => actor?._boxAppsItem === true;

const appIdOf = actor => {
    if (actor?.animatingOut)
        return null;
    return actor?.child?._delegate?.app?.get_id?.() ?? null;
};

// Folder icons for one Dash or dock.
//
// The folders sit inside the dock's own icon box, so they can go between any
// two apps. The dock's code is written for a box that only holds its own
// items: it counts children to work out where to insert icons and where a
// dragged app lands. To keep that code working, the box is given its own
// get_children(), insert_child_at_index() and set_child_at_index() that
// leave the folders out of the count. Clutter's layout code is written in C
// and does not see these, so the folders are still drawn and laid out.
export class DashFolders {
    constructor(dash, {store, settings, onRemove, onResetPosition, onSaveDrop, openPreferences, onDashDestroyed}) {
        this._dash = dash;
        this._box = dash._box;
        this._store = store;
        this._settings = settings;
        this._onRemove = onRemove;
        this._onResetPosition = onResetPosition;
        this._onSaveDrop = onSaveDrop;
        this._openPreferences = openPreferences;
        this._side = dash._position ?? St.Side.BOTTOM;
        this._horizontal = isHorizontalSide(this._side);
        this._folders = [];
        this._placing = false;
        this._placeLaterId = 0;
        this._draggedFolder = null;

        this._separator = new St.Widget({
            style_class: 'dash-separator box-apps-separator',
            visible: false,
        });
        this._separator._boxAppsItem = true;
        this._sizeSeparator();

        this._installBoxMethods();
        this._insertReal(this._separator, -1);

        // The dock adds and removes its icons whenever apps start, stop or
        // get pinned. Folders are put back in their place after each change.
        this._childSignalIds = [];
        for (const signal of ['child-added', 'child-removed', 'actor-added', 'actor-removed']) {
            try {
                this._childSignalIds.push(this._box.connect(signal, () => this._queuePlace()));
            } catch (e) {
                // Older GNOME versions use actor-*, newer ones child-*.
            }
        }

        this._iconSizeId = dash.connect('icon-size-changed', () => this._updateIconSize());
        // The dock destroys its dash when it rebuilds itself. The folders and
        // the box go with it, so only pending work has to be dropped.
        this._dashDestroyId = dash.connect('destroy', () => {
            this._cancelPlace();
            this._dash = null;
            this._box = null;
            onDashDestroyed();
        });

        this.rebuild();
    }

    get iconSize() {
        return this._dash?.iconSize ?? 48;
    }

    _cancelPlace() {
        if (this._placeLaterId) {
            global.compositor.get_laters().remove(this._placeLaterId);
            this._placeLaterId = 0;
        }
    }

    destroy() {
        this._cancelPlace();
        if (!this._dash)
            return;

        this._childSignalIds.forEach(id => this._box.disconnect(id));
        this._childSignalIds = [];
        this._dash.disconnect(this._iconSizeId);
        this._dash.disconnect(this._dashDestroyId);

        this._placing = true;
        this._folders.forEach(folder => folder.destroy());
        this._folders = [];
        this._separator.destroy();
        this._restoreBoxMethods();

        this._dash = null;
        this._box = null;
    }

    // Box methods

    _installBoxMethods() {
        const box = this._box;
        const proto = Object.getPrototypeOf(box);
        this._realGetChildren = () => proto.get_children.call(box);
        this._realInsert = (child, index) => proto.insert_child_at_index.call(box, child, index);
        this._realSetIndex = (child, index) => proto.set_child_at_index.call(box, child, index);

        // Index among the dock's own items -> index among all children.
        const toRealIndex = (index, ignore) => {
            const children = this._realGetChildren().filter(child => child !== ignore);
            if (index < 0)
                return -1;
            let count = 0;
            for (let i = 0; i < children.length; i++) {
                if (isOurs(children[i]))
                    continue;
                if (count === index)
                    return i;
                count++;
            }
            return -1;
        };

        box.get_children = () => this._realGetChildren().filter(child => !isOurs(child));
        box.insert_child_at_index = (child, index) => {
            this._realInsert(child, toRealIndex(index, null));
        };
        box.set_child_at_index = (child, index) => {
            this._realSetIndex(child, toRealIndex(index, child));
        };
    }

    _restoreBoxMethods() {
        delete this._box.get_children;
        delete this._box.insert_child_at_index;
        delete this._box.set_child_at_index;
    }

    _insertReal(child, index) {
        this._placing = true;
        this._realInsert(child, index);
        this._placing = false;
    }

    // Folders

    rebuild() {
        if (!this._box)
            return;

        this._placing = true;
        this._folders.forEach(folder => folder.destroy());
        this._folders = [];

        const columns = this._settings.get_int('popup-columns');
        for (const key of this._settings.get_strv('dock-folders')) {
            // Empty folders are skipped, like the App Grid hides them.
            const folder = this._store.getFolder(key);
            if (!folder || folder.apps.length === 0)
                continue;

            const dockFolder = new DockFolder({folder, host: this, side: this._side, columns});
            this._folders.push(dockFolder);
            this._realInsert(dockFolder.item, -1);
        }
        this._placing = false;

        this.place();
    }

    _queuePlace() {
        if (!this._box || this._placing || this._placeLaterId)
            return;

        // Runs before the next frame, so the dock's change and the folders
        // moving back into place show up together.
        this._placeLaterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._placeLaterId = 0;
            this.place();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Puts every folder after the pinned app it is anchored to. Folders with
    // no anchor, or whose app is no longer pinned, go at the end of the dock
    // after a separator. While a folder is being dragged it stays where the
    // pointer put it.
    place() {
        if (!this._box || this._draggedFolder)
            return;

        const anchors = this._settings.get_value('folder-anchors').deep_unpack();
        const dockItems = this._realGetChildren().filter(child => !isOurs(child));
        const favorites = AppFavorites.getAppFavorites();

        const first = [];
        const after = new Map();
        const last = [];
        for (const folder of this._folders) {
            const anchor = anchors[folder.key];
            if (anchor === '') {
                first.push(folder);
            } else if (anchor && favorites.isFavorite(anchor)) {
                if (!after.has(anchor))
                    after.set(anchor, []);
                after.get(anchor).push(folder);
            } else {
                last.push(folder);
            }
        }

        const order = first.map(folder => folder.item);
        for (const item of dockItems) {
            order.push(item);
            const id = appIdOf(item);
            if (id && after.has(id)) {
                order.push(...after.get(id).map(folder => folder.item));
                after.delete(id);
            }
        }
        // Anchored to a pinned app that has no icon right now.
        for (const folders of after.values())
            last.push(...folders);

        const showSeparator = last.length > 0 && dockItems.length > 0 &&
            this._settings.get_boolean('show-separator');
        this._separator.visible = showSeparator;
        order.push(this._separator);
        order.push(...last.map(folder => folder.item));

        this._placing = true;
        order.forEach((child, index) => {
            if (this._box.get_child_at_index(index) !== child)
                this._realSetIndex(child, index);
        });
        this._placing = false;
    }

    _sizeSeparator() {
        const size = this.iconSize;
        this._separator.set({
            x_align: this._horizontal ? Clutter.ActorAlign.FILL : Clutter.ActorAlign.CENTER,
            y_align: this._horizontal ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.FILL,
            width: this._horizontal ? -1 : size,
            height: this._horizontal ? size : -1,
        });
    }

    _updateIconSize() {
        this._folders.forEach(folder => folder.setIconSize(this.iconSize));
        this._sizeSeparator();
    }

    // Called by DockFolder

    notifyMenuState(item, open) {
        this._dash?._itemMenuStateChanged?.(item, open);
    }

    removeFolder(key) {
        this._onRemove(key);
    }

    resetPosition(key) {
        this._onResetPosition(key);
    }

    openPreferences() {
        this._openPreferences();
    }

    beginDrag(folder) {
        this._draggedFolder = folder;
    }

    // Moves the dragged folder to the slot under the pointer, so the empty
    // slot it leaves shows where it will be dropped.
    dragMotion(folder, stageX, stageY) {
        if (!this._box || this._draggedFolder !== folder)
            return;

        const [boxX, boxY] = this._box.get_transformed_position();
        const [boxWidth, boxHeight] = this._box.get_transformed_size();
        const margin = this.iconSize;
        const along = this._horizontal ? stageX - boxX : stageY - boxY;
        const across = this._horizontal ? stageY - boxY : stageX - boxX;
        const length = this._horizontal ? boxWidth : boxHeight;
        const thickness = this._horizontal ? boxHeight : boxWidth;

        // Only react while the pointer is over the dock.
        if (across < -margin || across > thickness + margin || along < -margin || along > length + margin)
            return;

        const others = this._realGetChildren()
            .filter(child => child !== folder.item && child.visible);
        let index = 0;
        for (const child of others) {
            const [x, y] = child.get_transformed_position();
            const [width, height] = child.get_transformed_size();
            const center = this._horizontal ? x - boxX + width / 2 : y - boxY + height / 2;
            if (center < along)
                index++;
        }

        const target = index < others.length ? others[index] : null;
        const children = this._realGetChildren().filter(child => child !== folder.item);
        const realIndex = target ? children.indexOf(target) : -1;

        this._placing = true;
        this._realSetIndex(folder.item, realIndex);
        this._placing = false;
    }

    // Works out which pinned app the folder now follows and saves it.
    endDrag(folder, save) {
        if (this._draggedFolder !== folder)
            return;
        this._draggedFolder = null;

        if (!save || !this._box) {
            this.place();
            return;
        }

        const children = this._realGetChildren();
        const favorites = AppFavorites.getAppFavorites();
        let anchor = '';
        for (let i = children.indexOf(folder.item) - 1; i >= 0; i--) {
            const child = children[i];
            if (isOurs(child))
                continue;
            const id = appIdOf(child);
            // After a running app, the trash or the dock's separator the
            // folder belongs to the end group, which has no anchor.
            anchor = id && favorites.isFavorite(id) ? id : null;
            break;
        }

        const visualOrder = children
            .filter(child => isOurs(child) && child !== this._separator)
            .map(child => this._folders.find(other => other.item === child)?.key)
            .filter(key => key);

        this._onSaveDrop(folder.key, anchor, visualOrder);
    }
}
