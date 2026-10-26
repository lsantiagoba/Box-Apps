import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as IconGrid from 'resource:///org/gnome/shell/ui/iconGrid.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// Same values the Dash uses for its own hover labels.
const LABEL_HOVER_TIMEOUT_MS = 300;
const LABEL_SHOW_TIME_MS = 150;
const LABEL_GAP = 8;
// Share of the folder icon taken by each of the four preview icons. The App
// Grid uses the same value.
const SUBICON_FRACTION = 0.4;
const POPUP_ICON_SIZE = 48;

// St.BoxLayout replaced "vertical" with "orientation" in GNOME 48.
const verticalBox = params => {
    const box = new St.BoxLayout(params);
    if ('orientation' in box)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
    return box;
};

// A dock item whose hover label appears beside the icon on whatever side of
// the screen the dock sits. The stock DashItemContainer always puts the
// label above, which only fits the Dash at the bottom of the overview.
const FolderItemContainer = GObject.registerClass(
class FolderItemContainer extends Dash.DashItemContainer {
    _init(side) {
        super._init();
        this._side = side;
    }

    showLabel() {
        if (!this._labelText)
            return;

        this.label.set_text(this._labelText);
        this.label.opacity = 0;
        this.label.show();

        const [stageX, stageY] = this.get_transformed_position();
        const [width, height] = this.get_transformed_size();
        const labelWidth = this.label.get_width();
        const labelHeight = this.label.get_height();

        let x, y;
        switch (this._side) {
        case St.Side.LEFT:
            x = stageX + width + LABEL_GAP;
            y = stageY + (height - labelHeight) / 2;
            break;
        case St.Side.RIGHT:
            x = stageX - labelWidth - LABEL_GAP;
            y = stageY + (height - labelHeight) / 2;
            break;
        case St.Side.TOP:
            x = stageX + (width - labelWidth) / 2;
            y = stageY + height + LABEL_GAP;
            break;
        default:
            x = stageX + (width - labelWidth) / 2;
            y = stageY - labelHeight - LABEL_GAP;
        }

        x = Math.clamp(Math.floor(x), 0, global.stage.width - labelWidth);
        y = Math.clamp(Math.floor(y), 0, global.stage.height - labelHeight);
        this.label.set_position(x, y);
        this.label.ease({
            opacity: 255,
            duration: LABEL_SHOW_TIME_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }
});

// The 2x2 preview drawn as the folder's icon, like folders in the App Grid.
const createPreviewIcon = (apps, size) => {
    const layout = new Clutter.GridLayout({
        row_homogeneous: true,
        column_homogeneous: true,
    });
    const radius = Math.round(size * 0.22);
    const icon = new St.Widget({
        style_class: 'box-apps-folder-icon',
        layout_manager: layout,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        style: `width: ${size}px; height: ${size}px; border-radius: ${radius}px;`,
    });

    const subSize = Math.floor(SUBICON_FRACTION * size);
    const rtl = icon.get_text_direction() === Clutter.TextDirection.RTL;
    for (let i = 0; i < 4; i++) {
        const bin = new St.Bin({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: `width: ${subSize}px; height: ${subSize}px;`,
        });
        if (i < apps.length)
            bin.child = apps[i].create_icon_texture(subSize);
        layout.attach(bin, rtl ? (i + 1) % 2 : i % 2, Math.floor(i / 2), 1, 1);
    }

    return icon;
};


// One folder in the dock: the icon, its hover label, the popup that lists
// the folder's apps and a right-click menu. The folder can be dragged along
// the dock; the host (DashFolders) moves it and saves where it was dropped.
export class DockFolder {
    constructor({folder, host, side, columns}) {
        this.key = folder.key;
        this._folder = folder;
        this._host = host;
        this._side = side;
        this._columns = columns;
        this._labelTimeoutId = 0;
        this._dragging = false;

        this.item = new FolderItemContainer(side);
        this.item.add_style_class_name('box-apps-folder-container');
        // Marks the item so DashFolders can tell it apart from dock items.
        this.item._boxAppsItem = true;

        this._button = new St.Button({
            style_class: 'overview-tile box-apps-folder',
            reactive: true,
            can_focus: true,
            track_hover: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
            x_expand: false,
            y_expand: false,
        });
        this._button._delegate = this;

        this._icon = new IconGrid.BaseIcon(folder.name, {
            createIcon: size => createPreviewIcon(this._folder.apps, size),
            setSizeManually: true,
            showLabel: false,
        });
        this._button.set_child(this._icon);

        this.item.setChild(this._button);
        this.item.setLabelText(folder.name);
        this.setIconSize(host.iconSize);
        this.item.show(false);

        this._menuManager = new PopupMenu.PopupMenuManager(this._button);
        this._menu = this._createMenu();
        this._contextMenu = this._createContextMenu();

        this._draggable = DND.makeDraggable(this._button);
        this._draggable.connect('drag-begin', () => this._onDragBegin());
        this._draggable.connect('drag-end', () => this._onDragEnd());

        this._button.connect('clicked', (_button, mouseButton) => {
            if (mouseButton === Clutter.BUTTON_SECONDARY)
                this._toggleMenu(this._contextMenu);
            else
                this.toggle();
        });
        this._button.connect('notify::hover', () => this._syncLabel());
        this.item.connect('destroy', () => this._onDestroy());
    }

    setIconSize(size) {
        this._icon.setIconSize(size);
    }

    toggle() {
        if (!this._menu.isOpen)
            this._fillMenu();
        this._toggleMenu(this._menu);
    }

    destroy() {
        this.item.destroy();
    }

    // Used by DND for the icon that follows the pointer while dragging.
    getDragActor() {
        return createPreviewIcon(this._folder.apps, this._host.iconSize);
    }

    getDragActorSource() {
        return this._icon;
    }

    _newMenu() {
        const menu = new PopupMenu.PopupMenu(this._button, 0.5, this._side);
        Main.uiGroup.add_child(menu.actor);
        menu.actor.hide();
        this._menuManager.addMenu(menu);
        menu._boxAppsStateId = menu.connect('open-state-changed',
            (_menu, open) => this._onMenuStateChanged(open));
        return menu;
    }

    _createMenu() {
        const menu = this._newMenu();
        menu.actor.add_style_class_name('box-apps-popup');
        return menu;
    }

    _createContextMenu() {
        const menu = this._newMenu();
        menu.addAction(_('Open'), () => this.toggle());
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction(_('Move to the end of the dock'), () => this._host.resetPosition(this.key));
        menu.addAction(_('Remove from dock'), () => this._host.removeFolder(this.key));
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction(_('Box Apps Settings'), () => this._host.openPreferences());
        return menu;
    }

    _toggleMenu(menu) {
        if (menu.isOpen)
            menu.close();
        else
            menu.open();
    }

    // Runs after the button is already gone, so the menus are closed without
    // going through _onMenuStateChanged, which would touch the button.
    _onDestroy() {
        this._clearLabelTimeout();
        if (this._dragging)
            this._host?.endDrag(this, false);

        for (const menu of [this._menu, this._contextMenu]) {
            if (!menu)
                continue;
            menu.disconnect(menu._boxAppsStateId);
            if (menu.isOpen)
                this._notifyDock(false);
            this._menuManager.removeMenu(menu);
            menu.destroy();
        }
        this._menu = null;
        this._contextMenu = null;
        this._host = null;
    }

    _clearLabelTimeout() {
        if (this._labelTimeoutId) {
            GLib.source_remove(this._labelTimeoutId);
            this._labelTimeoutId = 0;
        }
    }

    _anyMenuOpen() {
        return Boolean(this._menu?.isOpen || this._contextMenu?.isOpen);
    }

    _syncLabel() {
        this._clearLabelTimeout();

        if (this._button.hover && !this._anyMenuOpen() && !this._dragging) {
            this._labelTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                LABEL_HOVER_TIMEOUT_MS, () => {
                    this._labelTimeoutId = 0;
                    this.item.showLabel();
                    return GLib.SOURCE_REMOVE;
                });
        } else if (this.item.label) {
            this.item.hideLabel();
        }
    }

    _onMenuStateChanged(open) {
        this._button.checked = this._anyMenuOpen();
        if (open) {
            this._clearLabelTimeout();
            this.item.hideLabel();
        }

        this._notifyDock(open);
    }

    // Tells Ubuntu Dock / Dash to Dock that a menu is open, so the dock stays
    // visible while it is (intellihide and autohide).
    _notifyDock(open) {
        try {
            this._host?.notifyMenuState(this.item, open);
        } catch (e) {
            logError(e, 'Box Apps: could not notify the dock about the popup');
        }
    }

    _onDragBegin() {
        this._dragging = true;
        this._clearLabelTimeout();
        this.item.hideLabel();
        this._menu?.close();
        this._contextMenu?.close();
        // The empty slot left behind shows where the folder will land.
        this.item.opacity = 0;

        this._dragMonitor = {
            dragMotion: event => {
                if (event.source === this)
                    this._host?.dragMotion(this, event.x, event.y);
                return DND.DragMotionResult.CONTINUE;
            },
        };
        DND.addDragMonitor(this._dragMonitor);
        this._host?.beginDrag(this);
    }

    _onDragEnd() {
        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }
        this._dragging = false;
        this.item.opacity = 255;
        this._host?.endDrag(this, true);
    }

    // The popup is rebuilt each time it opens, so it always shows the
    // current apps of the folder.
    _fillMenu() {
        this._menu.removeAll();

        const content = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            activate: false,
            hover: false,
            style_class: 'box-apps-popup-content',
        });

        const box = verticalBox({
            x_expand: true,
            style_class: 'box-apps-popup-box',
        });
        content.add_child(box);

        box.add_child(new St.Label({
            text: this._folder.name,
            style_class: 'box-apps-popup-title',
            x_align: Clutter.ActorAlign.CENTER,
        }));

        if (this._folder.apps.length === 0) {
            box.add_child(new St.Label({
                text: _('No apps in this folder'),
                style_class: 'box-apps-popup-empty',
                x_align: Clutter.ActorAlign.CENTER,
            }));
        } else {
            box.add_child(this._createAppGrid());
        }

        this._menu.addMenuItem(content);
    }

    _createAppGrid() {
        const layout = new Clutter.GridLayout({
            row_homogeneous: true,
            column_homogeneous: true,
            row_spacing: 4,
            column_spacing: 4,
        });
        const grid = new St.Widget({
            style_class: 'box-apps-popup-grid',
            layout_manager: layout,
        });

        const columns = Math.min(this._columns, this._folder.apps.length);
        this._folder.apps.forEach((app, i) => {
            layout.attach(this._createAppTile(app), i % columns, Math.floor(i / columns), 1, 1);
        });

        // A scroll view only takes a scrollable child. St.BoxLayout is one,
        // a plain St.Widget is not.
        const viewport = verticalBox({});
        viewport.add_child(grid);

        const scrollView = new St.ScrollView({
            style_class: 'box-apps-popup-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        // St.ScrollView takes its child with set_child() since GNOME 46 and
        // with add_actor() before that.
        if (scrollView.set_child)
            scrollView.set_child(viewport);
        else
            scrollView.add_actor(viewport);

        return scrollView;
    }

    _createAppTile(app) {
        const tile = new St.Button({
            style_class: 'box-apps-app',
            reactive: true,
            can_focus: true,
            track_hover: true,
            accessible_name: app.get_name(),
        });

        const box = verticalBox({x_align: Clutter.ActorAlign.CENTER});
        box.add_child(new St.Bin({
            child: app.create_icon_texture(POPUP_ICON_SIZE),
            x_align: Clutter.ActorAlign.CENTER,
        }));

        const label = new St.Label({
            text: app.get_name(),
            style_class: 'box-apps-app-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(label);

        tile.set_child(box);
        tile.connect('clicked', () => {
            this._menu.close();
            Main.overview.hide();
            app.activate();
        });

        return tile;
    }
}
