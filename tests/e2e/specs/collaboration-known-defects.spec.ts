/**
 * Known defects that only a real browser can show.
 *
 * Each test states the correct behavior and is declared with `test.fail`,
 * so it passes while the defect is present and goes red once it is fixed.
 * When a change fixes one, change `test.fail` to `test`.
 * The Jest twins are in `tests/js/known-defects/`.
 */

/**
 * Internal dependencies
 */
import { test, expect } from '../config/collaboration-fixtures';
import { CONFLICT_CARD } from '../config/review-cards';

const TWO_PARAGRAPHS = [
	'<!-- wp:paragraph -->',
	'<p>Alice:</p>',
	'<!-- /wp:paragraph -->',
	'',
	'<!-- wp:paragraph -->',
	'<p>Bob:</p>',
	'<!-- /wp:paragraph -->',
].join( '\n' );

test.describe( 'Known defects - intent-log engine @engine-intent-log', () => {
	/*
	 * Two people each type in their own paragraph at the same moment. The
	 * edits do not touch each other, so no review card should appear.
	 *
	 * Today each tab's first edit also writes every paragraph's default
	 * attribute values (a paragraph's `dropCap: false`), because the
	 * server's first copy of the post leaves defaults out. Two writes to
	 * the same attribute that did not see each other are set aside, so
	 * both paragraphs get a review card. This is also why the two-person
	 * host benchmark fails. The fix is to take edits from Gutenberg's edit
	 * batches, which only name what changed.
	 */
	test.fail(
		'two people typing in their own paragraphs get no review card (known defect, to be fixed by taking edits from the Gutenberg edit batches)',
		async ( { collaborationUtils, requestUtils, editor, page } ) => {
			const post = await requestUtils.createPost( {
				title: 'Own paragraphs',
				status: 'draft',
				content: TWO_PARAGRAPHS,
				date_gmt: new Date().toISOString(),
			} );

			await collaborationUtils.openCollaborativeSession( post.id );
			const { editor2, page2 } = collaborationUtils;

			await editor.canvas
				.getByRole( 'document', { name: 'Block: Paragraph' } )
				.nth( 0 )
				.click();
			await editor2.canvas
				.getByRole( 'document', { name: 'Block: Paragraph' } )
				.nth( 1 )
				.click();
			await page.keyboard.press( 'End' );
			await page2.keyboard.press( 'End' );

			// Both first edits leave before either tab hears of the other.
			await Promise.all( [
				page.keyboard.type( ' one' ),
				page2.keyboard.type( ' two' ),
			] );

			// Both words reach both editors.
			for ( const canvas of [ editor.canvas, editor2.canvas ] ) {
				await expect( canvas.getByText( 'Alice: one' ) ).toBeVisible( {
					timeout: 15000,
				} );
				await expect( canvas.getByText( 'Bob: two' ) ).toBeVisible( {
					timeout: 15000,
				} );
			}

			// Give a set-aside edit time to show its card.
			await page.waitForTimeout( 3000 );
			for ( const canvas of [ editor.canvas, editor2.canvas ] ) {
				await expect( canvas.getByText( CONFLICT_CARD ) ).toHaveCount(
					0
				);
			}
		}
	);
} );
