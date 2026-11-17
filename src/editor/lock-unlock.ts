/**
 * Opens the private APIs of two Gutenberg packages.
 *
 * Gutenberg keeps some functions private: a package locks them away and
 * only hands them to code that opts in with a fixed consent text and the
 * name of a package that ships with WordPress. This plugin needs two of
 * them, so it opts in under the names of the packages it opens:
 *
 * - `unlockCoreData` opens `@wordpress/core-data`, for the one call that
 *   registers the sync provider (see register.ts).
 * - `unlockEditor` opens `@wordpress/editor`, for the comparison of two
 *   block lists that the review dialogs show (see
 *   src/review/revisions-diff.ts).
 *
 * Both are listed in gutenberg-contract.ts. The consent text can change
 * with any WordPress release, and the plugin then stops registering.
 */

/**
 * WordPress dependencies
 */
// eslint-disable-next-line import/no-unresolved -- Provided at runtime as wp.privateApis.
import { __dangerousOptInToUnstableAPIsOnlyForCoreModules } from '@wordpress/private-apis';

const CONSENT =
	'I acknowledge private features are not for use in themes or plugins and doing so will break in the next version of WordPress.';

export const { unlock: unlockCoreData } =
	__dangerousOptInToUnstableAPIsOnlyForCoreModules(
		CONSENT,
		'@wordpress/core-data'
	);

export const { unlock: unlockEditor } =
	__dangerousOptInToUnstableAPIsOnlyForCoreModules(
		CONSENT,
		'@wordpress/editor'
	);
