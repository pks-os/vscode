/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { IDisposable, Disposable } from '../../../../../base/common/lifecycle.js';
import { Position } from '../../../../common/core/position.js';
import { Range } from '../../../../common/core/range.js';

export class EditContextWrapper {

	private _textStartPositionWithinEditor: Position = new Position(1, 1);
	private _compositionRangeWithinEditor: Range | undefined;

	constructor(private readonly _editContext: EditContext) { }

	onTextUpdate(listener: (this: GlobalEventHandlers, ev: TextUpdateEvent) => void) {
		return editContextAddDisposableListener(this._editContext, 'textupdate', listener);
	}

	onCompositionStart(listener: (this: GlobalEventHandlers, ev: Event) => void) {
		return editContextAddDisposableListener(this._editContext, 'compositionstart', listener);
	}

	onCompositionEnd(listener: (this: GlobalEventHandlers, ev: Event) => void) {
		return editContextAddDisposableListener(this._editContext, 'compositionend', listener);
	}

	onCharacterBoundsUpdate(listener: (this: GlobalEventHandlers, ev: CharacterBoundsUpdateEvent) => void) {
		return editContextAddDisposableListener(this._editContext, 'characterboundsupdate', listener);
	}

	onTextFormatUpdate(listener: (this: GlobalEventHandlers, ev: TextFormatUpdateEvent) => void) {
		return editContextAddDisposableListener(this._editContext, 'textformatupdate', listener);
	}

	updateText(rangeStart: number, rangeEnd: number, text: string): void {
		this._editContext.updateText(rangeStart, rangeEnd, text);
	}

	updateSelection(selectionStart: number, selectionEnd: number): void {
		this._editContext.updateSelection(selectionStart, selectionEnd);
	}

	updateControlBounds(controlBounds: DOMRect): void {
		this._editContext.updateControlBounds(controlBounds);
	}

	updateSelectionBounds(selectionBounds: DOMRect): void {
		this._editContext.updateSelectionBounds(selectionBounds);
	}

	updateCharacterBounds(rangeStart: number, characterBounds: DOMRect[]): void {
		this._editContext.updateCharacterBounds(rangeStart, characterBounds);
	}

	updateTextStartPositionWithinEditor(textStartPositionWithinEditor: Position): void {
		this._textStartPositionWithinEditor = textStartPositionWithinEditor;
	}

	updateCompositionRangeWithinEditor(compositionRange: Range | undefined): void {
		this._compositionRangeWithinEditor = compositionRange;
	}

	public get text(): string {
		return this._editContext.text;
	}

	public get selectionStart(): number {
		return this._editContext.selectionStart;
	}

	public get selectionEnd(): number {
		return this._editContext.selectionEnd;
	}

	public get characterBounds(): DOMRect[] {
		return this._editContext.characterBounds();
	}

	public get textStartPositionWithinEditor(): Position {
		return this._textStartPositionWithinEditor;
	}

	public get compositionRangeWithinEditor(): Range | undefined {
		return this._compositionRangeWithinEditor;
	}
}

export class FocusTracker extends Disposable {
	private _isFocused: boolean = false;

	constructor(
		private readonly _domNode: HTMLElement,
		private readonly _onFocusChange: (newFocusValue: boolean) => void,
	) {
		super();
		this._register(addDisposableListener(this._domNode, 'focus', () => this._handleFocusedChanged(true)));
		this._register(addDisposableListener(this._domNode, 'blur', () => this._handleFocusedChanged(false)));
	}

	private _handleFocusedChanged(focused: boolean): void {
		if (this._isFocused === focused) {
			return;
		}
		this._isFocused = focused;
		this._onFocusChange(this._isFocused);
	}

	public focus(): void {
		this._domNode.focus();
	}

	get isFocused(): boolean {
		return this._isFocused;
	}
}

export function editContextAddDisposableListener<K extends keyof EditContextEventHandlersEventMap>(target: EventTarget, type: K, listener: (this: GlobalEventHandlers, ev: EditContextEventHandlersEventMap[K]) => any, options?: boolean | AddEventListenerOptions): IDisposable {
	target.addEventListener(type, listener as any, options);
	return {
		dispose() {
			target.removeEventListener(type, listener as any);
		}
	};
}
