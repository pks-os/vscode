/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DecorationOptions, l10n, Position, Range, TextEditor, TextEditorChange, TextEditorDecorationType, TextEditorChangeKind, ThemeColor, Uri, window, workspace, EventEmitter, ConfigurationChangeEvent, StatusBarItem, StatusBarAlignment, Command, MarkdownString } from 'vscode';
import { Model } from './model';
import { dispose, fromNow, IDisposable, pathEquals } from './util';
import { Repository } from './repository';
import { throttle } from './decorators';
import { BlameInformation } from './git';
import { fromGitUri, isGitUri } from './uri';

function lineRangesContainLine(changes: readonly TextEditorChange[], lineNumber: number): boolean {
	return changes.some(c => c.modified.startLineNumber <= lineNumber && lineNumber < c.modified.endLineNumberExclusive);
}

function lineRangeLength(startLineNumber: number, endLineNumberExclusive: number): number {
	return endLineNumberExclusive - startLineNumber;
}

function mapModifiedLineNumberToOriginalLineNumber(lineNumber: number, changes: readonly TextEditorChange[]): number {
	if (changes.length === 0) {
		return lineNumber;
	}

	for (const change of changes) {
		// Do not process changes after the line number
		if (lineNumber < change.modified.startLineNumber) {
			break;
		}

		// Map line number to the original line number
		if (change.kind === TextEditorChangeKind.Addition) {
			// Addition
			lineNumber = lineNumber - lineRangeLength(change.modified.startLineNumber, change.modified.endLineNumberExclusive);
		} else if (change.kind === TextEditorChangeKind.Deletion) {
			// Deletion
			lineNumber = lineNumber + lineRangeLength(change.original.startLineNumber, change.original.endLineNumberExclusive);
		} else if (change.kind === TextEditorChangeKind.Modification) {
			// Modification
			const originalRangeLength = lineRangeLength(change.original.startLineNumber, change.original.endLineNumberExclusive);
			const modifiedRangeLength = lineRangeLength(change.modified.startLineNumber, change.modified.endLineNumberExclusive);

			if (originalRangeLength !== modifiedRangeLength) {
				lineNumber = lineNumber - (modifiedRangeLength - originalRangeLength);
			}
		} else {
			throw new Error('Unexpected change kind');
		}
	}

	return lineNumber;
}

type BlameInformationTemplateTokens = {
	readonly hash: string;
	readonly hashShort: string;
	readonly subject: string;
	readonly authorName: string;
	readonly authorEmail: string;
	readonly authorDate: string;
	readonly authorDateAgo: string;
};

function formatBlameInformation(template: string, blameInformation: BlameInformation): string {
	const templateTokens = {
		hash: blameInformation.hash,
		hashShort: blameInformation.hash.substring(0, 8),
		subject: blameInformation.subject ?? '',
		authorName: blameInformation.authorName ?? '',
		authorEmail: blameInformation.authorEmail ?? '',
		authorDate: new Date(blameInformation.authorDate ?? new Date()).toLocaleString(),
		authorDateAgo: fromNow(blameInformation.authorDate ?? new Date(), true, true)
	} satisfies BlameInformationTemplateTokens;

	return template.replace(/\$\{(.+?)\}/g, (_, token) => {
		return token in templateTokens ? templateTokens[token as keyof BlameInformationTemplateTokens] : `\${${token}}`;
	});
}

interface RepositoryBlameInformation {
	readonly commit: string;
	readonly resource: Uri;
	readonly blameInformation: BlameInformation[];
}

interface LineBlameInformation {
	readonly lineNumber: number;
	readonly blameInformation: BlameInformation | string;
}

export class GitBlameController {
	private readonly _onDidChangeBlameInformation = new EventEmitter<TextEditor>();
	public readonly onDidChangeBlameInformation = this._onDidChangeBlameInformation.event;

	readonly textEditorBlameInformation = new Map<TextEditor, readonly LineBlameInformation[]>();

	private readonly _repositoryBlameInformation = new Map<Repository, RepositoryBlameInformation[]>();

	private _repositoryDisposables = new Map<Repository, IDisposable[]>();
	private _disposables: IDisposable[] = [];

	constructor(private readonly _model: Model) {
		this._disposables.push(new GitBlameEditorDecoration(this));
		this._disposables.push(new GitBlameStatusBarItem(this));

		this._model.onDidOpenRepository(this._onDidOpenRepository, this, this._disposables);
		this._model.onDidCloseRepository(this._onDidCloseRepository, this, this._disposables);

		window.onDidChangeTextEditorSelection(e => this._updateTextEditorBlameInformation(e.textEditor), this, this._disposables);
		window.onDidChangeTextEditorDiffInformation(e => this._updateTextEditorBlameInformation(e.textEditor), this, this._disposables);

		this._updateTextEditorBlameInformation(window.activeTextEditor);
	}

	getBlameInformationHover(documentUri: Uri, blameInformation: BlameInformation | string): MarkdownString {
		if (typeof blameInformation === 'string') {
			return new MarkdownString(blameInformation, true);
		}

		const markdownString = new MarkdownString();
		markdownString.supportThemeIcons = true;
		markdownString.isTrusted = true;

		if (blameInformation.authorName) {
			markdownString.appendMarkdown(`$(account) **${blameInformation.authorName}**`);

			if (blameInformation.authorDate) {
				const dateString = new Date(blameInformation.authorDate).toLocaleString(undefined, { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: 'numeric' });
				markdownString.appendMarkdown(`, $(history) ${fromNow(blameInformation.authorDate, true, true)} (${dateString})`);
			}

			markdownString.appendMarkdown('\n\n');
		}

		markdownString.appendMarkdown(`${blameInformation.subject}\n\n`);
		markdownString.appendMarkdown(`---\n\n`);

		markdownString.appendMarkdown(`[$(eye) View Commit](command:git.blameStatusBarItem.viewCommit?${encodeURIComponent(JSON.stringify([documentUri, blameInformation.hash]))} "${l10n.t('View Commit')}")`);
		markdownString.appendMarkdown('&nbsp;&nbsp;|&nbsp;&nbsp;');
		markdownString.appendMarkdown(`[$(copy) ${blameInformation.hash.substring(0, 8)}](command:git.blameStatusBarItem.copyContent?${encodeURIComponent(JSON.stringify(blameInformation.hash))} "${l10n.t('Copy Commit Hash')}")`);

		if (blameInformation.subject) {
			markdownString.appendMarkdown('&nbsp;&nbsp;');
			markdownString.appendMarkdown(`[$(copy) Subject](command:git.blameStatusBarItem.copyContent?${encodeURIComponent(JSON.stringify(blameInformation.subject))} "${l10n.t('Copy Commit Subject')}")`);
		}

		return markdownString;
	}

	private _onDidOpenRepository(repository: Repository): void {
		const repositoryDisposables: IDisposable[] = [];
		repository.onDidRunGitStatus(() => this._onDidRunGitStatus(repository), this, repositoryDisposables);

		this._repositoryDisposables.set(repository, repositoryDisposables);
	}

	private _onDidCloseRepository(repository: Repository): void {
		const disposables = this._repositoryDisposables.get(repository);
		if (disposables) {
			dispose(disposables);
		}

		this._repositoryDisposables.delete(repository);
		this._repositoryBlameInformation.delete(repository);
	}

	private _onDidRunGitStatus(repository: Repository): void {
		const repositoryBlameInformation = this._repositoryBlameInformation.get(repository);
		if (!repositoryBlameInformation) {
			return;
		}

		for (const textEditor of window.visibleTextEditors) {
			this._updateTextEditorBlameInformation(textEditor);
		}
	}

	private async _getBlameInformation(resource: Uri, commit: string): Promise<BlameInformation[] | undefined> {
		const repository = this._model.getRepository(resource);
		if (!repository) {
			return undefined;
		}

		const repositoryBlameInformation = this._repositoryBlameInformation.get(repository) ?? [];
		const resourceBlameInformation = repositoryBlameInformation
			.find(b => pathEquals(b.resource.fsPath, resource.fsPath) && b.commit === commit);
		if (resourceBlameInformation) {
			return resourceBlameInformation.blameInformation;
		}

		// Get blame information for the resource and cache it
		const blameInformation = await repository.blame2(resource.fsPath, commit) ?? [];

		repositoryBlameInformation.push({
			commit, resource, blameInformation
		} satisfies RepositoryBlameInformation);

		this._repositoryBlameInformation.set(repository, repositoryBlameInformation);

		return blameInformation;
	}

	@throttle
	private async _updateTextEditorBlameInformation(textEditor: TextEditor | undefined): Promise<void> {
		if (!textEditor?.diffInformation) {
			return;
		}

		const repository = this._model.getRepository(textEditor.document.uri);
		if (!repository || !repository.HEAD?.commit) {
			return;
		}

		// Working tree diff information
		const diffInformationWorkingTree = textEditor.diffInformation
			.filter(diff => diff.original && isGitUri(diff.original))
			.find(diff => fromGitUri(diff.original!).ref !== 'HEAD');

		// Working tree + index diff information
		const diffInformationWorkingTreeAndIndex = textEditor.diffInformation
			.filter(diff => diff.original && isGitUri(diff.original))
			.find(diff => fromGitUri(diff.original!).ref === 'HEAD');

		// Working tree diff information is not present or it is stale
		if (!diffInformationWorkingTree || diffInformationWorkingTree.isStale) {
			return;
		}

		// Working tree + index diff information is present and it is stale
		if (diffInformationWorkingTreeAndIndex && diffInformationWorkingTreeAndIndex.isStale) {
			return;
		}

		// For staged resources, we provide an additional "original resource" so that core can
		// compute the diff information that contains the changes from the working tree and the
		// index.
		const diffInformation = diffInformationWorkingTreeAndIndex ?? diffInformationWorkingTree;

		// Git blame information
		const resourceBlameInformation = await this._getBlameInformation(textEditor.document.uri, repository.HEAD.commit);
		if (!resourceBlameInformation) {
			return;
		}

		const lineBlameInformation: LineBlameInformation[] = [];
		for (const lineNumber of textEditor.selections.map(s => s.active.line)) {
			// Check if the line is contained in the working tree diff information
			if (lineRangesContainLine(diffInformationWorkingTree.changes, lineNumber + 1)) {
				lineBlameInformation.push({ lineNumber, blameInformation: l10n.t('Not Committed Yet') });
				continue;
			}

			// Check if the line is contained in the working tree + index diff information
			if (lineRangesContainLine(diffInformationWorkingTreeAndIndex?.changes ?? [], lineNumber + 1)) {
				lineBlameInformation.push({ lineNumber, blameInformation: l10n.t('Not Committed Yet (Staged)') });
				continue;
			}

			// Map the line number to the git blame ranges using the diff information
			const lineNumberWithDiff = mapModifiedLineNumberToOriginalLineNumber(lineNumber + 1, diffInformation.changes);
			const blameInformation = resourceBlameInformation.find(blameInformation => {
				return blameInformation.ranges.find(range => {
					return lineNumberWithDiff >= range.startLineNumber && lineNumberWithDiff <= range.endLineNumber;
				});
			});

			if (blameInformation) {
				lineBlameInformation.push({ lineNumber, blameInformation });
			}
		}

		this.textEditorBlameInformation.set(textEditor, lineBlameInformation);
		this._onDidChangeBlameInformation.fire(textEditor);
	}

	dispose() {
		for (const disposables of this._repositoryDisposables.values()) {
			dispose(disposables);
		}
		this._repositoryDisposables.clear();

		this._disposables = dispose(this._disposables);
	}
}

class GitBlameEditorDecoration {
	private readonly _decorationType: TextEditorDecorationType;
	private _disposables: IDisposable[] = [];

	constructor(private readonly _controller: GitBlameController) {
		this._decorationType = window.createTextEditorDecorationType({
			after: {
				color: new ThemeColor('git.blame.editorDecorationForeground')
			}
		});
		this._disposables.push(this._decorationType);

		workspace.onDidChangeConfiguration(this._onDidChangeConfiguration, this, this._disposables);
		this._controller.onDidChangeBlameInformation(e => this._updateDecorations(e), this, this._disposables);
	}

	private _onDidChangeConfiguration(e: ConfigurationChangeEvent): void {
		if (!e.affectsConfiguration('git.blame.editorDecoration.enabled') &&
			!e.affectsConfiguration('git.blame.editorDecoration.template')) {
			return;
		}

		for (const textEditor of window.visibleTextEditors) {
			if (this._getConfiguration().enabled) {
				this._updateDecorations(textEditor);
			} else {
				textEditor.setDecorations(this._decorationType, []);
			}
		}
	}

	private _getConfiguration(): { enabled: boolean; template: string } {
		const config = workspace.getConfiguration('git');
		const enabled = config.get<boolean>('blame.editorDecoration.enabled', false);
		const template = config.get<string>('blame.editorDecoration.template', '${subject}, ${authorName} (${authorDateAgo})');

		return { enabled, template };
	}

	private _updateDecorations(textEditor: TextEditor): void {
		const { enabled, template } = this._getConfiguration();
		if (!enabled) {
			return;
		}

		const blameInformation = this._controller.textEditorBlameInformation.get(textEditor);
		if (!blameInformation || textEditor.document.uri.scheme !== 'file') {
			textEditor.setDecorations(this._decorationType, []);
			return;
		}

		const decorations = blameInformation.map(blame => {
			const contentText = typeof blame.blameInformation === 'string'
				? blame.blameInformation
				: formatBlameInformation(template, blame.blameInformation);
			const hoverMessage = this._controller.getBlameInformationHover(textEditor.document.uri, blame.blameInformation);

			return this._createDecoration(blame.lineNumber, contentText, hoverMessage);
		});

		textEditor.setDecorations(this._decorationType, decorations);
	}

	private _createDecoration(lineNumber: number, contentText: string, hoverMessage: MarkdownString): DecorationOptions {
		const position = new Position(lineNumber, Number.MAX_SAFE_INTEGER);

		return {
			hoverMessage,
			range: new Range(position, position),
			renderOptions: {
				after: {
					contentText: `${contentText}`,
					margin: '0 0 0 50px'
				}
			},
		};
	}

	dispose() {
		this._disposables = dispose(this._disposables);
	}
}

class GitBlameStatusBarItem {
	private _statusBarItem: StatusBarItem | undefined;

	private _disposables: IDisposable[] = [];

	constructor(private readonly _controller: GitBlameController) {
		workspace.onDidChangeConfiguration(this._onDidChangeConfiguration, this, this._disposables);
		window.onDidChangeActiveTextEditor(this._onDidChangeActiveTextEditor, this, this._disposables);

		this._controller.onDidChangeBlameInformation(e => this._updateStatusBarItem(e), this, this._disposables);
	}

	private _onDidChangeConfiguration(e: ConfigurationChangeEvent): void {
		if (!e.affectsConfiguration('git.blame.statusBarItem.enabled') &&
			!e.affectsConfiguration('git.blame.statusBarItem.template')) {
			return;
		}

		if (this._getConfiguration().enabled) {
			if (window.activeTextEditor) {
				this._updateStatusBarItem(window.activeTextEditor);
			}
		} else {
			this._statusBarItem?.dispose();
			this._statusBarItem = undefined;
		}
	}

	private _onDidChangeActiveTextEditor(): void {
		if (!this._getConfiguration().enabled) {
			return;
		}

		if (window.activeTextEditor) {
			this._updateStatusBarItem(window.activeTextEditor);
		} else {
			this._statusBarItem?.hide();
		}
	}

	private _getConfiguration(): { enabled: boolean; template: string } {
		const config = workspace.getConfiguration('git');
		const enabled = config.get<boolean>('blame.statusBarItem.enabled', false);
		const template = config.get<string>('blame.statusBarItem.template', '${authorName} (${authorDateAgo})');

		return { enabled, template };
	}

	private _updateStatusBarItem(textEditor: TextEditor): void {
		const { enabled, template } = this._getConfiguration();
		if (!enabled || textEditor !== window.activeTextEditor) {
			return;
		}

		if (!this._statusBarItem) {
			this._statusBarItem = window.createStatusBarItem('git.blame', StatusBarAlignment.Right, 200);
			this._statusBarItem.name = l10n.t('Git Blame Information');
			this._disposables.push(this._statusBarItem);
		}

		const blameInformation = this._controller.textEditorBlameInformation.get(textEditor);
		if (!blameInformation || blameInformation.length === 0 || textEditor.document.uri.scheme !== 'file') {
			this._statusBarItem.hide();
			return;
		}

		if (typeof blameInformation[0].blameInformation === 'string') {
			this._statusBarItem.text = `$(git-commit) ${blameInformation[0].blameInformation}`;
			this._statusBarItem.tooltip = this._controller.getBlameInformationHover(textEditor.document.uri, blameInformation[0].blameInformation);
			this._statusBarItem.command = undefined;
		} else {
			this._statusBarItem.text = formatBlameInformation(template, blameInformation[0].blameInformation);
			this._statusBarItem.tooltip = this._controller.getBlameInformationHover(textEditor.document.uri, blameInformation[0].blameInformation);
			this._statusBarItem.command = {
				title: l10n.t('View Commit'),
				command: 'git.blameStatusBarItem.viewCommit',
				arguments: [textEditor.document.uri, blameInformation[0].blameInformation.hash]
			} satisfies Command;
		}

		this._statusBarItem.show();
	}

	dispose() {
		this._disposables = dispose(this._disposables);
	}
}
