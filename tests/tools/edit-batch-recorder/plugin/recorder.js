/**
 * The recording sync provider.
 *
 * It registers with core-data as a sync provider and syncs nothing. It only
 * writes down every call core-data makes, so we can see what a real editor
 * sends. The driver script reads the log from `window.__editBatchRecorder`.
 *
 * Plain JavaScript with no build step, printed inline after `wp-core-data`.
 */

/* eslint-env browser */
( function () {
	const wp = window.wp;
	const recorder = {
		registered: false,
		error: null,
		events: [],
		handlers: {},
		lastTrees: {},
		undoLevelOpen: {},
		counter: 0,
	};
	window.__editBatchRecorder = recorder;

	const CONSENT =
		'I acknowledge private features are not for use in themes or plugins and doing so will break in the next version of WordPress.';

	/**
	 * Turns a value into plain JSON and keeps what JSON would lose: rich
	 * text objects, `undefined`, and functions.
	 *
	 * @param {*} value Any value from a batch or a block tree.
	 * @return {*} A value that survives JSON.stringify.
	 */
	function toPlain( value ) {
		if ( value === undefined ) {
			return { __type: 'undefined' };
		}

		if ( value === null ) {
			return null;
		}

		if ( typeof value === 'function' ) {
			return { __type: 'function' };
		}

		if ( typeof value !== 'object' ) {
			return value;
		}

		const RichTextData = wp.richText && wp.richText.RichTextData;
		if ( RichTextData && value instanceof RichTextData ) {
			return {
				__type: 'RichTextData',
				html: value.toHTMLString(),
				text: value.text,
			};
		}

		if ( Array.isArray( value ) ) {
			return value.map( toPlain );
		}

		const result = {};
		for ( const key of Object.keys( value ) ) {
			result[ key ] = toPlain( value[ key ] );
		}

		return result;
	}

	/**
	 * Copies a block tree, keeping the parts that describe the document.
	 *
	 * @param {Array|undefined} blocks Editor blocks.
	 * @return {Array|null} Plain copy, or null when there is no tree.
	 */
	function copyTree( blocks ) {
		if ( ! Array.isArray( blocks ) ) {
			return null;
		}

		return blocks.map( ( block ) => ( {
			clientId: block.clientId,
			name: block.name,
			isValid: block.isValid,
			attributes: toPlain( block.attributes ),
			innerBlocks: copyTree( block.innerBlocks ),
		} ) );
	}

	function recordKey( kind, name, recordId ) {
		return kind + '/' + name + '/' + String( recordId );
	}

	/**
	 * Reads the block tree core-data holds for a record right now.
	 *
	 * @param {string}        kind     Entity kind.
	 * @param {string}        name     Entity name.
	 * @param {string|number} recordId Record id.
	 * @return {Array|null} Plain copy of the tree, or null.
	 */
	function readCoreDataTree( kind, name, recordId ) {
		if ( recordId === undefined ) {
			return null;
		}

		const record = wp.data
			.select( 'core' )
			.getEditedEntityRecord( kind, name, recordId );
		if ( ! record || ! Array.isArray( record.blocks ) ) {
			return null;
		}

		return copyTree( record.blocks );
	}

	function push( event ) {
		event.index = recorder.counter++;
		event.time = Math.round( window.performance.now() * 10 ) / 10;
		recorder.events.push( event );

		return event;
	}

	function create() {
		return {
			services: {
				getAwareness: () => undefined,
				getEntitySnapshot: () => undefined,
				entityContainsSnapshot: () => false,
				createPersistedCRDTDoc: async () => null,
			},

			shouldSync() {
				return true;
			},

			isLoaded( kind, name, recordId ) {
				return Boolean(
					recorder.handlers[ recordKey( kind, name, recordId ) ]
				);
			},

			load( kind, name, recordId, record, handlers ) {
				const key = recordKey( kind, name, recordId );
				const tree = copyTree( record.blocks );
				recorder.handlers[ key ] = handlers;
				if ( tree ) {
					recorder.lastTrees[ key ] = tree;
				}
				push( {
					call: 'load',
					kind,
					name,
					recordId,
					recordFields: Object.keys( record ).sort(),
					hasBlocks: Array.isArray( record.blocks ),
					blockTypesRegistered: wp.blocks.getBlockTypes().length,
					tree,
				} );
			},

			loadCollection( kind, name ) {
				push( { call: 'loadCollection', kind, name } );
			},

			applyEditBatch( kind, name, recordId, batch ) {
				const key = recordKey( kind, name, recordId );
				const hasBlockOperation = batch.operations.some(
					( operation ) => operation.type !== 'set-field'
				);

				// The store has not applied this edit yet, so this is the
				// tree before the batch. Before the first block edit core-data
				// holds no tree, so fall back to the last one we saw.
				let before = readCoreDataTree( kind, name, recordId );
				let beforeSource = 'core-data';
				if ( ! before ) {
					before = recorder.lastTrees[ key ] || null;
					beforeSource = 'last-seen';
				}

				const event = push( {
					call: 'applyEditBatch',
					kind,
					name,
					recordId: recordId === undefined ? null : recordId,
					batch: toPlain( batch ),
					treeBefore: null,
					treeBeforeSource: beforeSource,
					treeAfter: null,
				} );
				if ( hasBlockOperation ) {
					event.treeBefore = before;
				}

				// Report undo levels the way a real engine would, so the
				// recording also shows the undo and redo calls. A change
				// that is not typing always opens a level. Typing opens one
				// only when none is open.
				const handlers = recorder.handlers[ key ];
				if ( handlers && ! batch.options.undoIgnore ) {
					if (
						! batch.options.isCached ||
						! recorder.undoLevelOpen[ key ]
					) {
						handlers.onUndoLevelOpened();
						event.openedUndoLevel = true;
					}

					recorder.undoLevelOpen[ key ] = true;
				}

				// Read the tree after the batch in a later task.
				setTimeout( () => {
					const after = readCoreDataTree( kind, name, recordId );
					if ( after ) {
						recorder.lastTrees[ key ] = after;
					}

					if ( hasBlockOperation ) {
						event.treeAfter = after;
					}
				}, 0 );
			},

			beforeSave( kind, name, recordId, edits, context ) {
				push( {
					call: 'beforeSave',
					kind,
					name,
					recordId,
					editFields: Object.keys( edits ).sort(),
					isAutosave: context.isAutosave,
				} );
			},

			afterSave( kind, name, recordId, context ) {
				push( {
					call: 'afterSave',
					kind,
					name,
					recordId: recordId === undefined ? null : recordId,
					editFields: Object.keys( context.edits ).sort(),
				} );
			},

			unload( kind, name, recordId ) {
				delete recorder.handlers[ recordKey( kind, name, recordId ) ];
				push( { call: 'unload', kind, name, recordId } );
			},

			unloadAll() {
				recorder.handlers = {};
				push( { call: 'unloadAll' } );
			},

			undoHistory: {
				undo( kind, name, recordId ) {
					push( { call: 'undo', kind, name, recordId } );

					return false;
				},
				redo( kind, name, recordId ) {
					push( { call: 'redo', kind, name, recordId } );

					return false;
				},
				stopCapturing() {
					recorder.undoLevelOpen = {};
					push( { call: 'stopCapturing' } );
				},
				clearRedo() {
					push( { call: 'clearRedo' } );
				},
			},
		};
	}

	recorder.toPlain = toPlain;
	recorder.copyTree = copyTree;

	try {
		const { unlock } =
			wp.privateApis.__dangerousOptInToUnstableAPIsOnlyForCoreModules(
				CONSENT,
				'@wordpress/core-data'
			);
		const { registerEntitySyncProvider } = unlock(
			wp.coreData.privateApis
		);
		recorder.flagAtRegistration = Boolean(
			window.__experimentalEnableRealTimeCollaboration
		);
		registerEntitySyncProvider( create );
		recorder.registered = true;
	} catch ( error ) {
		recorder.error = String( error && error.message );
	}
} )();
