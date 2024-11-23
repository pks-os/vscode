/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import * as nls from '../../../nls.js';
import { IGalleryExtension, AllowedExtensionsConfigKey, IAllowedExtensionsService } from './extensionManagement.js';
import { ExtensionType, IExtension, TargetPlatform } from '../../extensions/common/extensions.js';
import { IProductService } from '../../product/common/productService.js';
import { IMarkdownString, MarkdownString } from '../../../base/common/htmlContent.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IStringDictionary } from '../../../base/common/collections.js';
import { isBoolean, isObject, isUndefined } from '../../../base/common/types.js';
import { Emitter } from '../../../base/common/event.js';

function isGalleryExtension(extension: any): extension is IGalleryExtension {
	return extension.type === 'gallery';
}

function isIExtension(extension: any): extension is IExtension {
	return extension.type === ExtensionType.User || extension.type === ExtensionType.System;
}


const VersionRegex = /^(?<version>\d+\.\d+\.\d+(-.*)?)(@(?<platform>.+))?$/;

type AllowedExtensionsConfigValueType = IStringDictionary<boolean | string | string[]>;

export class AllowedExtensionsService extends Disposable implements IAllowedExtensionsService {

	_serviceBrand: undefined;

	private allowedExtensions: AllowedExtensionsConfigValueType | undefined;
	private readonly publisherMappings: IStringDictionary<string> = {};

	private _onDidChangeAllowedExtensions = this._register(new Emitter<void>());
	readonly onDidChangeAllowedExtensions = this._onDidChangeAllowedExtensions.event;

	constructor(
		@IProductService productService: IProductService,
		@IConfigurationService protected readonly configurationService: IConfigurationService
	) {
		super();
		for (const key in productService.extensionPublisherMappings) {
			this.publisherMappings[key.toLowerCase()] = productService.extensionPublisherMappings[key].toLowerCase();
		}
		this.allowedExtensions = this.getAllowedExtensionsValue();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AllowedExtensionsConfigKey)) {
				this.allowedExtensions = this.getAllowedExtensionsValue();
				this._onDidChangeAllowedExtensions.fire();
			}
		}));
	}

	private getAllowedExtensionsValue(): AllowedExtensionsConfigValueType | undefined {
		const value = this.configurationService.getValue<AllowedExtensionsConfigValueType | undefined>(AllowedExtensionsConfigKey);
		if (!isObject(value) || Array.isArray(value)) {
			return undefined;
		}
		const entries = Object.entries(value).map(([key, value]) => [key.toLowerCase(), value]);
		if (entries.length === 1 && entries[0][0] === '*' && entries[0][1] === true) {
			return undefined;
		}
		return Object.fromEntries(entries);
	}

	isAllowed(extension: IGalleryExtension | IExtension | { id: string; version?: string; prerelease?: boolean; targetPlatform?: TargetPlatform }): true | IMarkdownString {
		if (!this.allowedExtensions) {
			return true;
		}

		let id: string, version: string, targetPlatform: TargetPlatform, prerelease: boolean, publisher: string;

		if (isGalleryExtension(extension)) {
			id = extension.identifier.id.toLowerCase();
			version = extension.version;
			prerelease = extension.properties.isPreReleaseVersion;
			publisher = extension.publisher.toLowerCase();
			targetPlatform = extension.properties.targetPlatform;
		} else if (isIExtension(extension)) {
			id = extension.identifier.id.toLowerCase();
			version = extension.manifest.version;
			prerelease = extension.preRelease;
			publisher = extension.manifest.publisher.toLowerCase();
			targetPlatform = extension.targetPlatform;
		} else {
			id = extension.id.toLowerCase();
			version = extension.version ?? '*';
			targetPlatform = extension.targetPlatform ?? TargetPlatform.UNIVERSAL;
			prerelease = extension.prerelease ?? false;
			publisher = extension.id.substring(0, extension.id.indexOf('.')).toLowerCase();
		}

		const settingsCommandLink = URI.parse(`command:workbench.action.openSettings?${encodeURIComponent(JSON.stringify({ query: `@id:${AllowedExtensionsConfigKey}` }))}`).toString();
		const extensionValue = this.allowedExtensions[id];
		const extensionReason = new MarkdownString(nls.localize('specific extension not allowed', "it is not in the [allowed list]({0})", settingsCommandLink));
		if (!isUndefined(extensionValue)) {
			if (isBoolean(extensionValue)) {
				return extensionValue ? true : extensionReason;
			}
			if (extensionValue === 'release' && prerelease) {
				return new MarkdownString(nls.localize('extension prerelease not allowed', "the pre-release versions of this extension are not in the [allowed list]({0})", settingsCommandLink));
			}
			if (version !== '*' && Array.isArray(extensionValue) && !extensionValue.some(v => {
				const match = VersionRegex.exec(v);
				if (match && match.groups) {
					const { platform: p, version: v } = match.groups;
					if (v !== version) {
						return false;
					}
					if (targetPlatform !== TargetPlatform.UNIVERSAL && p && targetPlatform !== p) {
						return false;
					}
					return true;
				}
				return false;
			})) {
				return extensionReason;
			}
			return true;
		}

		publisher = (this.publisherMappings[publisher])?.toLowerCase() ?? publisher;
		const publisherValue = this.allowedExtensions[publisher];
		if (!isUndefined(publisherValue)) {
			if (isBoolean(publisherValue)) {
				return publisherValue ? true : new MarkdownString(nls.localize('publisher not allowed', "the extensions from this publisher are not in the [allowed list]({1})", publisher, settingsCommandLink));
			}
			if (publisherValue === 'release' && prerelease) {
				return new MarkdownString(nls.localize('prerelease versions from this publisher not allowed', "the pre-release versions from this publisher are not in the [allowed list]({1})", publisher, settingsCommandLink));
			}
			return true;
		}

		if (this.allowedExtensions['*'] === true) {
			return true;
		}

		return extensionReason;
	}
}
