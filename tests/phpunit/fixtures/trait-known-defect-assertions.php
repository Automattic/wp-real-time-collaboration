<?php
/**
 * Known_Defect_Assertions trait
 *
 * @package gutenberg
 */

if ( ! trait_exists( 'Known_Defect_Assertions' ) ) {

	/**
	 * TEST FIXTURE: marks a test that proves a defect nobody has fixed yet.
	 *
	 * PHPUnit 9 has no "expected failure" marker. A test that uses this
	 * trait states the CORRECT behavior. While the defect is still there,
	 * the assertions fail and the test passes. Once the defect is fixed,
	 * the assertions pass and the test fails, with a message that says to
	 * remove the marker.
	 *
	 * To see the real failure of each defect, run the suite with the
	 * environment variable RTC_KNOWN_DEFECTS_RAW=1. The marker then steps
	 * aside and every assertion reports as usual.
	 *
	 * Loaded by tests/bootstrap.php, never in production code.
	 */
	trait Known_Defect_Assertions {

		/**
		 * Runs assertions that describe correct behavior for a known defect.
		 *
		 * @param string   $fixed_in   The plan phase that fixes the defect,
		 *                             for example 'Phase 4'.
		 * @param callable $assertions Assertions that state the correct
		 *                             behavior. Keep the test's setup and
		 *                             its sanity checks outside of this.
		 * @param string   $throwable  Optional class name. A Throwable of
		 *                             this class, raised by the code under
		 *                             test, also counts as the defect.
		 */
		protected function assert_known_defect( string $fixed_in, callable $assertions, string $throwable = '' ): void {
			if ( getenv( 'RTC_KNOWN_DEFECTS_RAW' ) ) {
				$assertions();
				return;
			}

			$still_present = false;

			try {
				$assertions();
			} catch ( PHPUnit\Framework\AssertionFailedError $failure ) {
				// A skipped or incomplete test is not a failed assertion.
				if ( $failure instanceof PHPUnit\Framework\SkippedTest || $failure instanceof PHPUnit\Framework\IncompleteTest ) {
					throw $failure;
				}
				$still_present = true;
			} catch ( Throwable $error ) {
				if ( '' === $throwable || ! ( $error instanceof $throwable ) ) {
					throw $error;
				}
				$still_present = true;
			}

			$this->assertTrue(
				$still_present,
				"This defect looks fixed. Remove the known-defect marker. (Fixed in {$fixed_in})"
			);
		}
	}
}
