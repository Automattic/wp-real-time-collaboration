/**
 * WordPress dependencies
 */
import apiFetch from '@wordpress/api-fetch';

/*
 * The taxonomies of a post type, by the name the REST API uses for them
 * on a post (`categories`, `tags`). A post's terms sync as post fields
 * under those names.
 */

const lookups = new Map< string, Promise< string[] > >();

/**
 * Looks up the taxonomies of a post type. The answer is kept for the
 * life of the page. When the lookup fails, the post type is taken to have
 * none, and its terms travel with saves only.
 *
 * @param postType The post type.
 * @return The REST names of its taxonomies.
 */
export function fetchPostTypeTaxonomies(
	postType: string
): Promise< string[] > {
	let lookup = lookups.get( postType );

	if ( ! lookup ) {
		lookup = ( async () => {
			try {
				const [ types, taxonomies ] = await Promise.all( [
					apiFetch< Record< string, { taxonomies?: string[] } > >( {
						path: '/wp/v2/types?context=view',
					} ),
					apiFetch< Record< string, { rest_base?: string } > >( {
						path: '/wp/v2/taxonomies?context=view',
					} ),
				] );

				return ( types?.[ postType ]?.taxonomies ?? [] ).flatMap(
					( taxonomy ) => {
						const base = taxonomies?.[ taxonomy ]?.rest_base;

						if ( base ) {
							return [ base ];
						}

						return [];
					}
				);
			} catch {
				return [];
			}
		} )();
		lookups.set( postType, lookup );
	}

	return lookup;
}
