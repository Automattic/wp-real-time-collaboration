/*
 * Finds the one change that turns an old text into a new text.
 *
 * The editor reports a text edit as the whole old value and the whole new
 * value. The engine needs the change itself: where it starts, what was
 * removed, and what was inserted.
 *
 * Comparing the start and the end of the two texts is not enough. Typing
 * "a" after the first "a" of "aaa" gives "aaaa", and the comparison cannot
 * tell which "a" is new. The caret can: the editor reports where the caret
 * is after the edit, and the text after the caret did not change.
 *
 *   old "aaa", new "aaaa", caret after the edit at 2
 *   the text after the caret is "aa", so the edit is: insert "a" at 1
 *
 * Positions count UTF-16 units, as the engine's text edits do. A change
 * never starts or ends between the two units of one character, such as an
 * emoji.
 */

/**
 * One change to a text.
 */
export interface TextChange {
	/** Where the change starts in the old text. */
	start: number;
	/** The old text that was removed, starting at `start`. */
	removed: string;
	/** The new text that took its place. */
	inserted: string;
}

/**
 * What the editor's selection says about a text edit.
 */
export interface CaretHint {
	/** The caret in the new text, right after the edit. */
	after?: number;
	/**
	 * The selection in the old text, right before the edit, when it was a
	 * range. Typing over a selection replaces exactly that range.
	 */
	before?: { start: number; end: number };
}

/**
 * The result of looking for a change.
 */
export interface TextChangeResult {
	/** The change, or null when the two texts are equal. */
	change: TextChange | null;
	/**
	 * True when a caret was given but did not fit the two texts, so the
	 * plain comparison of start and end was used.
	 */
	caretFailed: boolean;
}

/**
 * Whether a UTF-16 unit is the first half of a two-unit character.
 *
 * @param unit The unit.
 * @return Whether it is a first half.
 */
function isFirstHalf( unit: number ): boolean {
	return unit >= 0xd800 && unit <= 0xdbff;
}

/**
 * Whether a UTF-16 unit is the second half of a two-unit character.
 *
 * @param unit The unit.
 * @return Whether it is a second half.
 */
function isSecondHalf( unit: number ): boolean {
	return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * How many units two texts share at their start, counted in whole
 * characters.
 *
 * @param a One text.
 * @param b The other text.
 * @return The shared length.
 */
function sharedStart( a: string, b: string ): number {
	const limit = Math.min( a.length, b.length );
	let length = 0;

	while ( length < limit && a[ length ] === b[ length ] ) {
		length++;
	}

	// The texts share the first half of a character and then differ: the
	// character is not shared.
	if ( length > 0 && isFirstHalf( a.charCodeAt( length - 1 ) ) ) {
		length--;
	}

	return length;
}

/**
 * How many units two texts share at their end, counted in whole
 * characters.
 *
 * @param a     One text.
 * @param b     The other text.
 * @param limit The most units to count, so the shared end cannot overlap a
 *              shared start.
 * @return The shared length.
 */
function sharedEnd( a: string, b: string, limit: number ): number {
	let length = 0;

	while (
		length < limit &&
		a[ a.length - 1 - length ] === b[ b.length - 1 - length ]
	) {
		length++;
	}

	// The shared end starts with the second half of a character: the
	// character is not shared.
	if ( length > 0 && isSecondHalf( a.charCodeAt( a.length - length ) ) ) {
		length--;
	}

	return length;
}

/**
 * Finds a change by comparing the start and the end of two texts.
 *
 * @param before The old text.
 * @param after  The new text.
 * @return The change.
 */
function compareStartAndEnd( before: string, after: string ): TextChange {
	const start = sharedStart( before, after );
	const end = sharedEnd(
		before,
		after,
		Math.min( before.length, after.length ) - start
	);

	return {
		start,
		removed: before.slice( start, before.length - end ),
		inserted: after.slice( start, after.length - end ),
	};
}

/**
 * Finds a change with the help of the caret after the edit.
 *
 * @param before The old text.
 * @param after  The new text.
 * @param hint   What the selection says. `hint.after` must be set.
 * @return The change, or null when the caret does not fit the texts.
 */
function compareWithCaret(
	before: string,
	after: string,
	hint: CaretHint
): TextChange | null {
	const caret = hint.after;

	if ( undefined === caret || caret < 0 || caret > after.length ) {
		return null;
	}

	// The text after the caret is the same in both texts.
	const tailLength = after.length - caret;

	if (
		tailLength > before.length ||
		before.slice( before.length - tailLength ) !== after.slice( caret )
	) {
		return null;
	}

	// A caret between the two halves of a character is not a real caret.
	if (
		tailLength > 0 &&
		isSecondHalf( after.charCodeAt( caret ) ) &&
		caret > 0 &&
		isFirstHalf( after.charCodeAt( caret - 1 ) )
	) {
		return null;
	}

	const oldHead = before.slice( 0, before.length - tailLength );
	const newHead = after.slice( 0, caret );
	let start = sharedStart( oldHead, newHead );

	// Typing over a selection replaces the whole selection, even when the
	// new text begins with the same letters as the old.
	if ( hint.before && hint.before.start < hint.before.end ) {
		const selectionStart = hint.before.start;
		const cutsCharacter =
			selectionStart > 0 &&
			isFirstHalf( oldHead.charCodeAt( selectionStart - 1 ) ) &&
			isSecondHalf( oldHead.charCodeAt( selectionStart ) );

		// The texts are equal up to `start`, so they are equal up to an
		// earlier selection start too.
		if (
			selectionStart >= 0 &&
			selectionStart < start &&
			hint.before.end <= oldHead.length &&
			! cutsCharacter
		) {
			start = selectionStart;
		}
	}

	return {
		start,
		removed: oldHead.slice( start ),
		inserted: newHead.slice( start ),
	};
}

/**
 * Applies a change to a text.
 *
 * @param text   The old text.
 * @param change The change.
 * @return The new text.
 */
export function applyTextChange( text: string, change: TextChange ): string {
	return (
		text.slice( 0, change.start ) +
		change.inserted +
		text.slice( change.start + change.removed.length )
	);
}

/**
 * Finds the one change that turns `before` into `after`.
 *
 * With a caret, the change is placed where the person made it. Without
 * one, or when the caret does not fit the two texts, the start and the end
 * of the texts are compared.
 *
 * @param before The old text.
 * @param after  The new text.
 * @param hint   What the editor's selection says about the edit.
 * @return The change, and whether a given caret had to be ignored.
 */
export function findTextChange(
	before: string,
	after: string,
	hint: CaretHint = {}
): TextChangeResult {
	if ( before === after ) {
		return { change: null, caretFailed: false };
	}

	if ( undefined !== hint.after ) {
		const change = compareWithCaret( before, after, hint );

		// Confirm the change: applied to the old text it must give the new
		// text.
		if ( change && applyTextChange( before, change ) === after ) {
			return { change, caretFailed: false };
		}

		return {
			change: compareStartAndEnd( before, after ),
			caretFailed: true,
		};
	}

	return { change: compareStartAndEnd( before, after ), caretFailed: false };
}
