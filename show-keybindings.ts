/**
 * Show Keybindings Extension
 *
 * Adds a /keybindings command that displays all current keybindings
 * in a scrollable overlay, showing effective keys and highlighting
 * user overrides with *.
 *
 * Commands:
 *   /keybindings - Show all keybindings
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import type { Component, KeybindingsManager, TUI } from "@mariozechner/pi-tui";
import type { Keybinding } from "@mariozechner/pi-tui";

const SECTIONS: { title: string; ids: string[] }[] = [
	{
		title: "Editor - Cursor",
		ids: [
			"tui.editor.cursorUp",
			"tui.editor.cursorDown",
			"tui.editor.cursorLeft",
			"tui.editor.cursorRight",
			"tui.editor.cursorWordLeft",
			"tui.editor.cursorWordRight",
			"tui.editor.cursorLineStart",
			"tui.editor.cursorLineEnd",
			"tui.editor.jumpForward",
			"tui.editor.jumpBackward",
			"tui.editor.pageUp",
			"tui.editor.pageDown",
		],
	},
	{
		title: "Editor - Deletion",
		ids: [
			"tui.editor.deleteCharBackward",
			"tui.editor.deleteCharForward",
			"tui.editor.deleteWordBackward",
			"tui.editor.deleteWordForward",
			"tui.editor.deleteToLineStart",
			"tui.editor.deleteToLineEnd",
		],
	},
	{
		title: "Editor - Kill Ring",
		ids: ["tui.editor.yank", "tui.editor.yankPop", "tui.editor.undo"],
	},
	{
		title: "Input",
		ids: ["tui.input.newLine", "tui.input.submit", "tui.input.tab", "tui.input.copy"],
	},
	{
		title: "Select / Menus",
		ids: [
			"tui.select.up",
			"tui.select.down",
			"tui.select.pageUp",
			"tui.select.pageDown",
			"tui.select.confirm",
			"tui.select.cancel",
		],
	},
	{
		title: "Application",
		ids: [
			"app.interrupt",
			"app.clear",
			"app.exit",
			"app.suspend",
			"app.editor.external",
			"app.clipboard.pasteImage",
		],
	},
	{
		title: "Models & Thinking",
		ids: [
			"app.model.select",
			"app.model.cycleForward",
			"app.model.cycleBackward",
			"app.thinking.cycle",
			"app.thinking.toggle",
		],
	},
	{
		title: "Display",
		ids: ["app.tools.expand", "app.message.followUp", "app.message.dequeue"],
	},
	{
		title: "Sessions",
		ids: [
			"app.session.new",
			"app.session.resume",
			"app.session.fork",
			"app.session.tree",
			"app.session.togglePath",
			"app.session.toggleSort",
			"app.session.toggleNamedFilter",
			"app.session.rename",
			"app.session.delete",
			"app.session.deleteNoninvasive",
		],
	},
	{
		title: "Tree",
		ids: ["app.tree.foldOrUp", "app.tree.unfoldOrDown"],
	},
];

// Max visible length of any keybinding ID is 29 ("app.session.toggleNamedFilter")
const ID_COL = 29;
// Max keys string e.g. "alt+left, ctrl+left, alt+b" = 26
const KEYS_COL = 27;
// Full line: │(1) _(1) id(29) _(1) keys(27) _(1) desc(d) _(1) mod(1) _(1) │(1)
// innerW = width-2 (excludes the two border │ chars)
// Within innerW: _(1)+id+_(1)+keys+_(1)+desc+_(1)+mod(1) = d + ID_COL + KEYS_COL + 5
// But the outer ` ` before right │ is part of `${row} │`, adding 1 more: total fixed = 6
// descColW = innerW - ID_COL - KEYS_COL - 6
const FIXED_OVERHEAD = ID_COL + KEYS_COL + 6; // 6 = 4 spacers + 1 mod + 1 trailing space

function trunc(text: string, width: number): string {
	if (width <= 0) return "";
	if (text.length <= width) return text;
	return `${text.slice(0, width - 1)}…`;
}

function rpad(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - text.length));
}

class KeybindingsViewer implements Component {
	private scrollOffset = 0;
	private lastWidth = 0;
	// All scrollable body lines (between header and footer)
	private bodyLines: string[] = [];
	private headerLine = "";
	private footerLine = "";
	private readonly termRows: number;

	constructor(
		tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly done: () => void,
	) {
		this.termRows = tui.terminal.rows;
	}

	// Number of body lines visible at once (excludes header + footer rows)
	private get viewportHeight(): number {
		return Math.max(3, Math.floor(this.termRows * 0.85) - 2);
	}

	private buildRow(
		id: string,
		keys: string[],
		description: string,
		isModified: boolean,
		descColW: number,
	): string {
		const th = this.theme;

		// ID: color prefix dim, action normal
		const dot = id.lastIndexOf(".");
		const prefix = dot >= 0 ? id.slice(0, dot + 1) : "";
		const idPlain = trunc(id, ID_COL);
		const prefixInId = idPlain.slice(0, Math.min(prefix.length, idPlain.length));
		const actionInId = idPlain.slice(prefixInId.length);
		const coloredId =
			th.fg("dim", prefixInId) + th.fg("text", rpad(actionInId, ID_COL - prefixInId.length));

		// Keys: warning if overridden, success otherwise
		const keysStr = keys.length > 0 ? keys.join(", ") : "(none)";
		const keysTrunc = trunc(keysStr, KEYS_COL);
		const coloredKeys = th.fg(isModified ? "warning" : "success", rpad(keysTrunc, KEYS_COL));

		// Description
		const descTrunc = rpad(trunc(description, descColW), descColW);
		const coloredDesc = th.fg("muted", descTrunc);

		// Modified mark
		const mod = isModified ? th.fg("warning", "*") : " ";

		return `${coloredId} ${coloredKeys} ${coloredDesc} ${mod}`;
	}

	private buildContent(width: number): void {
		const th = this.theme;
		const innerW = width - 2; // space inside │ ... │

		const descColW = Math.max(0, innerW - FIXED_OVERHEAD);

		const userBindings = this.keybindings.getUserBindings();
		const resolved = this.keybindings.getResolvedBindings();

		// Header
		const titleText = " Keybindings ";
		const hint = " ↑↓/PgUp/PgDn scroll  q/Esc close  * = overridden ";
		const hintWidth = Math.max(0, innerW - visibleWidth(titleText) - visibleWidth(hint));
		this.headerLine =
			th.fg("border", "╭") +
			th.fg("accent", titleText) +
			th.fg("border", "─".repeat(hintWidth)) +
			th.fg("dim", hint) +
			th.fg("border", "╮");

		this.footerLine = th.fg("border", `╰${"─".repeat(innerW)}╯`);

		// Body lines
		const body: string[] = [];

		for (const section of SECTIONS) {
			// Section separator line
			const secLabel = ` ${section.title} `;
			const secDashes = "─".repeat(Math.max(0, innerW - visibleWidth(secLabel) - 1));
			body.push(
				th.fg("border", "│") +
					th.fg("accent", secLabel) +
					th.fg("border", secDashes + " ") +
					th.fg("border", "│"),
			);

			for (const id of section.ids) {
				const rawKeys = resolved[id];
				const keysArr = Array.isArray(rawKeys) ? rawKeys : rawKeys ? [rawKeys] : [];
				const isModified = id in userBindings;

				let description = "";
				try {
					description = this.keybindings.getDefinition(id as Keybinding)?.description ?? "";
				} catch {
					// Unknown id — leave blank
				}

				const row = this.buildRow(id, keysArr, description, isModified, descColW);
				body.push(`${th.fg("border", "│")} ${row} ${th.fg("border", "│")}`);
			}
		}

		this.bodyLines = body;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			this.done();
			return;
		}

		const maxScroll = Math.max(0, this.bodyLines.length - this.viewportHeight);

		if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
		} else if (matchesKey(data, "pageUp")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - this.viewportHeight);
		} else if (matchesKey(data, "pageDown")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + this.viewportHeight);
		} else if (matchesKey(data, "home")) {
			this.scrollOffset = 0;
		} else if (matchesKey(data, "end")) {
			this.scrollOffset = maxScroll;
		}
	}

	render(width: number): string[] {
		if (width !== this.lastWidth) {
			this.lastWidth = width;
			this.buildContent(width);
			// Clamp scroll after rebuild
			const maxScroll = Math.max(0, this.bodyLines.length - this.viewportHeight);
			this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
		}

		const viewport = this.bodyLines.slice(this.scrollOffset, this.scrollOffset + this.viewportHeight);
		// Pad to fill the viewport so the footer stays at a fixed position
		const th = this.theme;
		const innerW = this.lastWidth - 2;
		while (viewport.length < this.viewportHeight) {
			viewport.push(`${th.fg("border", "│")}${" ".repeat(innerW)}${th.fg("border", "│")}`);
		}

		return [this.headerLine, ...viewport, this.footerLine];
	}

	invalidate(): void {
		this.lastWidth = 0;
	}

	dispose(): void {}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("keybindings", {
		description: "Show all current keybindings in a scrollable overlay",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("The keybindings viewer requires interactive mode", "error");
				return;
			}

			// Capture termRows from TUI inside the factory so overlayOptions can use it
			let termRows = 24;

			await ctx.ui.custom<void>(
				(tui, theme, keybindings, done) => {
					termRows = tui.terminal.rows;
					return new KeybindingsViewer(tui, theme, keybindings, () => done(undefined));
				},
				{
					overlay: true,
					overlayOptions: () => ({
						width: "90%",
						maxHeight: Math.floor(termRows * 0.85),
						anchor: "center",
					}),
				},
			);
		},
	});
}
