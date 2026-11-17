/**
 * Picks the longest run of numbers that is already in rising order.
 *
 * Used to find the blocks that did not move: of the blocks that stay in a
 * parent, the largest group whose order is the same before and after.
 *
 * @param values The numbers.
 * @return The positions in `values` of the numbers that were picked.
 */
export function longestRisingRun( values: number[] ): Set< number > {
	// tails[ n ] is the position of the smallest number that ends a rising
	// run of length n + 1.
	const tails: number[] = [];
	const previous: number[] = new Array( values.length ).fill( -1 );

	for ( let index = 0; index < values.length; index++ ) {
		let low = 0;
		let high = tails.length;

		while ( low < high ) {
			const middle = Math.floor( ( low + high ) / 2 );

			if ( values[ tails[ middle ] ] < values[ index ] ) {
				low = middle + 1;
			} else {
				high = middle;
			}
		}

		if ( low > 0 ) {
			previous[ index ] = tails[ low - 1 ];
		}

		tails[ low ] = index;
	}

	const picked = new Set< number >();
	let cursor = tails.length > 0 ? tails[ tails.length - 1 ] : -1;

	while ( cursor >= 0 ) {
		picked.add( cursor );
		cursor = previous[ cursor ];
	}

	return picked;
}
