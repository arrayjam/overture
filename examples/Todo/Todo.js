/*  Todo – OvertureJS Example App

    © 2014 FastMail Pty Ltd. MIT Licensed.

    General styling and background image from TodoMVC – http://todomvc.com

    The classic example of every JS framework, the Todo demo app makes use of
    a large part of the Overture library to show off some of the features. I
    (perhaps somewhat ambitiously) decided to see how complete a Todo app I
    could create in one day, and this is the current result. It has drag/drop
    reorder, full keyboard shortcuts, live search and undo/redo. I didn't have
    time to do start dates, multiple lists and smart views, but there's support
    for most of this in the model already and when I find a few spare hours
    I'll update this demo app to showcase a few more library features.

    – Neil Jenkins (2014-12-19)
*/

/*global O */

"use strict";

// --- Namespace ---

/*  There's no specific naming requirement for your app when using Overture,
    but it keeps things tidy if you keep everything in a single namespace.
*/
var App = {};

// --- Model ---

/*  The source is the connection from the store to the server for fetching
    and modifying records. The RPCSource automatically uses the JSON API format
    used in the [JMAP](http://jmap.io) spec for communicating with the server,
    but you could also easily build one to use HTTP REST, or even a local
    IndexDB database.

    There's no backend implemented for this little todo demo, so I've faked one
    (see fixtures.js). However, check the console if you want to see the
    requests the client is making to the server.
*/
App.source = new O.RPCSource({
    url: '/api/'
});
/*  The store instance stores the locally cached copies of the different
    records in the model. It keeps track of what has changed compared to the
    copy received from the source, and can then send those changes to the source
    to be committed. It can keep track of further changes whilst the current
    ones are being committed and resolve things when the commit succeeds or
    fails.

    I've turned off auto-commit, so it will only send changes to the store when
    O.Store#commitChanges is explicitly called. This is because when editing
    todos, the text field is just bound directly to the summary in the model,
    and we don't want it to commit on every keystroke; just when the user has
    finished editing.

    In more complex apps, you would often use an O.NestedStore to create a
    copy-on-write view of the original store. This allows you to edit stuff
    and commit it back independently; I've kept it simpler here.
*/
App.store = new O.Store({
    source: App.source,
    autoCommit: false
});
/* A StoreUndoManager hooks into the store to provide automatic undo support.
   Each time the store commits changes to the source, the UndoManager
   automatically records an undo checkpoint.
*/
App.undoManager = new O.StoreUndoManager({
    store: App.store,
    maxUndoCount: 10
});

// ---

/*
    A TodoList is simply a name for a collection of todos. All todos belong
    to a single TodoList.

    I ran out of time to build support into the UI for multiple todo lists;
    pull requests welcome!
*/
var TodoList = O.Class({

    Extends: O.Record,

    _id: O.Record.attr( String, {
        isPrimaryKey: true,
        key: 'id'
    }),

    name: O.Record.attr( String, {
        defaultValue: '',
        validate: function ( propValue/*, propKey, record*/ ) {
            var error = '';
            if ( !propValue ) {
                error = O.loc( 'Required' );
            }
            else if ( propValue.length > 25 ) {
                error = O.loc( 'Too long: use at most [*2,_1,%n character,%n characters].', 25 );
            }
            return error;
        }
    })
});

/*
    We tell the source how to fetch, create, modify etc. TodoLists.
*/
App.source.handle( TodoList, {
    precedence: 1,
    fetch: 'getTodoLists',
    commit: 'setTodoLists',
    // Response handlers
    todoLists: function ( args ) {
        this.didFetchAll( TodoList, args );
    },
    todoListsSet: function ( args ) {
        this.didCommit( TodoList, args );
    }
});

// ---

var Todo = O.Class({

    Extends: O.Record,

    _id: O.Record.attr( String, {
        isPrimaryKey: true,
        key: 'id'
    }),

    list: O.Record.toOne({
        Type: TodoList,
        key: 'listId'
    }),

    precedence: O.Record.attr( Number, {
        isNullable: false,
        defaultValue: 0
    }),

    isComplete: O.Record.attr( Boolean, {
        isNullable: false,
        defaultValue: false
    }),

    summary: O.Record.attr( String, {
        isNullable: false,
        defaultValue: ''
    }),

    // Ran out of time! TODO: add support for scheduling todos in UI.
    // start: O.Record.attr( Date, {
    //     defaultValue: null
    // }),

    autoCommitIsComplete: function () {
        if ( !( this.get( 'status' ) & O.Status.NEW ) ) {
            App.store.commitChanges();
        }
    }.observes( 'isComplete' )
});

App.source.handle( Todo, {
    precedence: 2,
    fetch: 'getTodos',
    commit: 'setTodos',
    // Response handlers
    todos: function ( args ) {
        this.didFetchAll( Todo, args );
    },
    todosSet: function ( args ) {
        this.didCommit( Todo, args );
    }
});

/// --- UI State & Routing

/*
    We hold the general application state (as opposed to the data state) in
    this object.
*/
App.state = new O.Router({

    listId: '',
    search: '',

    /* The currently selected TodoList. This is always "Inbox" at the moment,
       but it would be easy to extend the UI to allow you to switch between
       lists.
    */
    list: function () {
        return App.store.getRecord( TodoList, this.get( 'listId' ) );
    }.property( 'listId' ),

    /* An observable collection of Todo instances that belong to the currently
       selected TodoList and match any search.

       This is a query on our local store, and will automatically update if the
       data in the store changes.
    */
    todos: function () {
        var listId = this.get( 'listId' ),
            search = this.get( 'search' ),
            andTerm = O.Parse.define( 'and_term', /^[^\s]+/ ),
            whitespace = O.Parse.define( 'whitespace', /^(?:\s+)/ ),

            doneString = 'done',
            notDoneString = 'notdone',
            donePrefix = O.Parse.define( 'done_prefix', /^is:/ ),
            doneValue = O.Parse.define( 'done_value', new RegExp( '^(' + doneString + '|' + notDoneString + ')' ) ),

            done = O.Parse.sequence([
                donePrefix,
                O.Parse.optional( whitespace ),
                doneValue
            ]),

            andTerms = O.Parse.firstMatch([
                done,
                andTerm,
                whitespace
            ]),

            or = O.Parse.define( 'or', /^OR/i ),
            orTerm = O.Parse.define( 'or_term', /^[^\s]+/ ),
            orTerms = O.Parse.firstMatch([
                done,
                orTerm,
                whitespace
            ]),
            orSeqStart = O.Parse.sequence([
                orTerms,
                whitespace,
                or,
                whitespace
            ]),
            orSeqEnd = O.Parse.sequence([
                O.Parse.repeat( orSeqStart, 1 ),
                orTerms
            ]),
            orSeq = O.Parse.longestMatch([ orSeqEnd ]),
            parser = O.Parse.longestMatch([ orSeq, andTerms ]),
            tokenType = function ( tokens, type ) {
                var returnTokens = tokens.filter( function ( token ) {
                    return token[0] === type;
                } );

                return returnTokens;
            },

            wordsMatch = function ( tokens, searchCandidate ) {
                for( var wordIndex = 0; wordIndex < tokens.length; wordIndex += 1 ) {
                    // TODO(yuri): Possibly make prefixes of is:done and
                    // is:notdone return true?
                    if ( searchCandidate.indexOf( tokens[wordIndex][1] )  === -1 ) {
                        return false;
                    }
                }
                return true;
            },

            doneStateMatch = function ( tokens, isComplete ) {
                if( tokens.length ) {
                    // NOTE(yuri): Take the first is:done/is:notdone
                    if ( tokens[0][1] === doneString && !isComplete ) {
                        return false;
                    } else if ( tokens[0][1] === notDoneString && isComplete ) {
                        return false;
                    }
                }
                return true;
            };

        return new O.LiveQuery({
            store: App.store,
            Type: Todo,
            sort: function ( a, b ) {
                return ( a.precedence - b.precedence ) ||
                    ( a.id < b.id ? -1 : a.id > b.id ? 1 : 0 );
            },
            filter: function ( data ) {
                if ( data.listId !== listId ) {
                    return false;
                }

                var searchCandidate = data.summary.toLowerCase();
                var parse = new O.Parse( search );

                while( parse.string.length ) {
                    parser( parse );

                    // NOTE(yuri): Filter out unused tokens
                    parse.tokens = parse.tokens.filter( function ( token ) {
                        return token[0] !== 'whitespace' && token[0] !== 'done_prefix';
                    });

                    parse.tokens.forEach( function ( token ) { token[1] = token[1].toLowerCase(); });

                    // NOTE(yuri): When we come across a token of interest, we
                    // process it and empty out the tokens so that we're only
                    // dealing with one condition at a time
                    // TODO(yuri): When implementing NOT, use a variable to
                    // keep track of result instead of short-ciruting logic
                    // with returns
                    var orTokens = tokenType( parse.tokens, 'or' );
                    if ( tokenType( parse.tokens, 'or' ).length ) {
                        orTokens = parse.tokens.filter( function ( token ) { return token[0] !== 'or'; } );
                        parse.tokens = [];

                        var orResult = orTokens.reduce( function ( memo, token ) {
                            if ( token[0] === 'or_term' ) {
                                memo = memo || wordsMatch( [token], searchCandidate );
                            } else if ( token[0] === 'done_value' ) {
                                memo = memo || doneStateMatch( [token], data.isComplete );
                            }
                            return memo;
                        }, false );

                        if ( !orResult ) { return false; }
                    }

                    var andTokens = tokenType( parse.tokens, 'and_term' );
                    if ( andTokens.length ) {
                        parse.tokens = [];

                        if ( !wordsMatch( andTokens, searchCandidate ) ) {
                            return false;
                        }
                    }

                    var doneTokens = tokenType( parse.tokens, 'done_value' );
                    if ( doneTokens.length ) {
                        parse.tokens = [];

                        if ( !doneStateMatch( doneTokens, data.isComplete ) ) {
                            return false;
                        }
                    }
                }

                return true;
            }
        });
    }.property( 'listId', 'search' ),

    /* Destroy the previous LiveQuery, as it's no longer needed. In the current
       implementation we're not reusing queries, so we should always destroy
       the old ones, otherwise we will leak memory (and time, as each old
       query is kept up to date!)
    */
    cleanupTodos: function ( _, __, oldQuery ) {
        if ( oldQuery ) {
            oldQuery.destroy();
        }
    }.observes( 'todos' ),

    /* TODO: Use this property to show a loading animation in the list while
       the initial data is loading (irrelevant with fixtures, but important
       if we had a real backend)
    */
    isLoadingList: false,

    /* If the current TodoList is destroyed, go back to the Inbox TodoList
       (we assume this is always present). If we arrived via a URL, we may have
       tried to load a list id that doesn't actually exist; in this case, the
       same behaviour is applied.
    */
    checkListStatus: function ( _, __, ___, status )  {
        if ( status & (O.Status.DESTROYED|O.Status.NON_EXISTENT) ) {
            this.set( 'listId', 'inbox' );
        } else {
            this.set( 'isLoadingList', !!( status & O.Status.LOADING ) );
        }
    }.observes( 'list.status' ),

    /* If we switch lists, clear any current search.
    */
    clearSearch: function () {
        this.set( 'search', '' );
    }.observes( 'listId' ),

    /* The Todo currently being edited.
    */
    editTodo: null,

    /* When we finish editing a todo, commit the changes back to the source
       (this automatically records an Undo checkpoint as well).
    */
    commitChanges: function ( _, __, oldTodo ) {
        if ( oldTodo !== null ) {
            App.store.commitChanges();
        }
    }.observes( 'editTodo' ),

    // Page title

    /* The title of our page (as displayed in the browser window/tab).
    */
    title: function () {
        var appName = 'Overture Todo Example';
        var listName = this.getFromPath( 'list.name' );
        return listName ? listName + ' – ' + appName : appName;
    }.property( 'list' ),

    // URL routing (state encoding/decoding)

    /* To use HTML5 URL rewriting, the router needs to know where the app is
       located relative to the root of the domain. */
    baseUrl: '/examples/Todo/',

    /* This is the URL the browser should show. This is dependent on the current
       selected TodoList, but I've decided not to encode any search in the URL.
    */
    encodedState: function () {
        return this.get( 'listId' ) + '/';
    }.property( 'listId' ),

    /* Routes are simply a regexp to match against the URL (after any base part)
       and then a function to use to restore the state from that URL.

       The handle fns are called in the context of the App.state object, and
       are supplied with any capture groups in the regexp as arguments 1+.
    */
    routes: [
        {
            url: /^(.*?)\/$/,
            handle: function ( _, listId ) {
                this.set( 'listId', listId );
            }
        },
        // Fallback route; if the user comes in via a nonsense URL, just
        // go to our default view.
        {
            url: /.*/,
            handle: function () {
                /* Don't keep the old state in history */
                this.set( 'replaceState', true );
                this.set( 'listId', 'inbox' );
            }
        }
    ]
});

// --- Selection ---

/* The SingleSelectionController is for keeping track of which element is
   selected in a list. There's another class "SelectionController" (not
   currently used in this example app) for keeping track of a multi-selection.
*/
App.selectedTodo = new O.SingleSelectionController({
    content: O.bind( App.state, 'todos' )
});

// --- Actions ---

/* Self explanatory */
App.actions = {
    selectNext: function () {
        var list = App.state.get( 'todos' ),
            index = App.selectedTodo.get( 'index' ) + 1;
        if ( index < list.get( 'length' ) ) {
            App.selectedTodo.set( 'index', index );
        }
    },

    selectPrevious: function () {
        var index = App.selectedTodo.get( 'index' );
        if ( index > 0 ) {
            App.selectedTodo.set( 'index', index - 1 );
        }
    },

    newTodo: function () {
        // Create todo
        var todos = App.state.get( 'todos' ),
            selectedIndex = App.selectedTodo.get( 'index' ),
            newTodo = new Todo( App.store );

        // Assign to the currently selected list.
        newTodo.set( 'list',
            App.state.get( 'list' ).getDoppelganger( App.store ) );

        // Place just after selected todo, or at end of list if none selected
        this.reorderTodo( todos, newTodo,
            selectedIndex > -1 ? selectedIndex + 1 : todos.get( 'length' )
        );
        newTodo.saveToStore();

        // Select new todo
        App.store.refreshLiveQueries();
        App.selectedTodo.set( 'record', newTodo );
        App.state.set( 'editTodo', newTodo );
    },

    reorderTodo: function ( list, todo, toIndex ) {
        var index = list.indexOf( todo ),
            prev, next, prevPrec, nextPrec,
            i, p, l, otherTodo;

        if ( index === toIndex ) {
            return;
        }
        if ( -1 < index && index < toIndex ) {
            prev = list.getObjectAt( toIndex );
            next = list.getObjectAt( toIndex + 1 ) || null;
        } else {
            prev = toIndex ? list.getObjectAt( toIndex - 1 ) : null;
            next = list.getObjectAt( toIndex );
        }

        prevPrec = prev ? prev.get( 'precedence' ) : 0;
        nextPrec = next ? next.get( 'precedence' ) : ( toIndex + 2 ) * 32;

        if ( nextPrec - prevPrec < 2 ) {
            for ( i = 0, p = 32, l = list.get( 'length' );
                    i < l; i += 1, p += 32 ) {
                otherTodo = list.getObjectAt( i );
                if ( otherTodo !== todo ) {
                    otherTodo.set( 'precedence', p );
                    if ( otherTodo === prev ) {
                        p += 32;
                    }
                }
            }
            if ( prev ) { prevPrec = prev.get( 'precedence' ); }
            if ( next ) { nextPrec = next.get( 'precedence' ); }
        }
        todo.set( 'precedence', ( nextPrec + prevPrec ) >> 1 );
    },

    toggleComplete: function () {
        var todo = App.selectedTodo.get( 'record' );
        if ( todo ) {
            todo.toggle( 'isComplete' );
        }
    },

    edit: function () {
        var todo = App.selectedTodo.get( 'record' );
        if ( todo ) {
            App.state.set( 'editTodo', todo );
        }
    },

    destroy: function () {
        var todo = App.selectedTodo.get( 'record' );
        if ( todo ) {
            todo.destroy();
        }
        App.store.commitChanges();
    }
};

/* Self explanatory */
App.keyboardShortcuts = new O.GlobalKeyboardShortcuts()
    .register( 'down', App.actions, 'selectNext' )
    .register( 'up', App.actions, 'selectPrevious' )
    .register( 'j', App.actions, 'selectNext' )
    .register( 'k', App.actions, 'selectPrevious' )
    .register( 'cmd-shift-z', App.undoManager, 'redo' )
    .register( 'space', App.actions, 'toggleComplete' )
    .register( 'tab', App.actions, 'edit' )
    .register( 'backspace', App.actions, 'destroy' );

// --- Views ---

/* A RootView instance is required for each browser window under the control of
   your app
*/
App.views = {
    mainWindow: new O.RootView( document, {
        selectNone: function ( event ) {
            if ( !( event.targetView instanceof O.ButtonView ) ) {
                App.state.set( 'editTodo', null );
                App.selectedTodo.set( 'record', null );
            }
        }.on( 'click' )
    })
};

/* The TodoView is used to render a Todo. The content property (set
   automatically by the ListView) is expected to be an instance of Todo.
*/
var TodoView = O.Class({

    Extends: O.ListItemView,

    /* By mixing in O.AnimatableView, any changes to the "layout" property will
       automatically be animated. Mixing in O.Draggable allows a drag to be
       initiated on the view.
    */
    Mixin: [ O.AnimatableView, O.Draggable ],

    /* Turn off animation by default (it's just enabled while dragging)
       Also make the duration shorter than the default.
    */
    animateLayer: false,
    animateLayerDuration: 200,

    isComplete: O.bind( 'content.isComplete' ),

    /* Inside a binding transform, `this` is the binding itself. We want to
       compare the object with Todo of this view, which can be found as the
       content property on the binding's toObject.
    */
    isEditing: O.bind( App.state, 'editTodo', function ( editTodo ) {
        return this.toObject.get( 'content' ) === editTodo;
    }),

    isSelected: O.bind( App.selectedTodo, 'record', function ( record ) {
        return this.toObject.get( 'content' ) === record;
    }),

    /* We define what the classname should be; Overture handles redrawing the
       DOM node to keep it in sync.
    */
    className: function () {
        return 'v-Todo' +
            ( this.get( 'isComplete' ) ? ' is-complete' : '' ) +
            ( this.get( 'isSelected' ) ? ' is-selected' : '' ) +
            ( this.get( 'isEditing' )  ? ' is-editing'  : '' );
    }.property('isComplete', 'isSelected', 'isEditing' ),

    /* Position the view absolutely to make it easy to animate.
    */
    itemHeight: 48,

    /* When dragging, we'll set the layout manually from the drag handlers.
       Otherwise, the layout purely depends on how far down the list we are.
    */
    layout: function ( y ) {
        if ( y === undefined ) {
            y = ( this.get( 'index' ) * this.get( 'itemHeight' ) );
        }
        return {
            zIndex: this.get( 'isDragging' ) ? '1' : 'auto',
            transform: 'translate3d(0,' + y + 'px,0)'
        };
    }.property( 'isDragging' ),

    /* We would normally make index one of the computed property dependencies
       of layout, but because we don't want it to reset while dragging, we
       do it manually in this observer instead (automatically triggered
       whenever the index property chagnes).
    */
    invalidateLayout: function () {
        if ( !this.get( 'isDragging' ) ) {
            this.computedPropertyDidChange( 'layout' );
        }
    }.observes( 'index' ),

    /* Draw the view. Since it's such a common pattern, we can just return an
       array of children to be appended to the layer (the root node of the
       view).

       Note, we can append other view instances as well as DOM nodes.
    */
    draw: function ( layer, Element, el ) {
        var todo = this.get( 'content' );
        return [
            new O.CheckboxView({
                positioning: 'absolute',
                /* Two-way bindings are rarely needed, but here we use one to
                   keep the checkbox in sync with the todo state, but also allow
                   you to use the checkbox to update the todo.
                */
                value: O.bindTwoWay( todo, 'isComplete' )
            }),
            /* Element.when is a shortcut for creating an O.SwitchView
               instance; essentially a live-updating if/else.
            */
            Element.when( this, 'isEditing' ).show([
                el( 'div.v-Todo-summary', [
                    new O.TextView({
                        value: O.bindTwoWay( todo, 'summary' ),
                        autoFocus: function () {
                            if ( this.get( 'isInDocument' ) ) {
                                this.focus();
                            }
                        }.observes( 'isInDocument' )
                    })
                ])
            ]).otherwise([
                el( 'div.v-Todo-summary', {
                    /* You can bind directly to DOM properties (text is a
                       special case to save you having to write textContent
                       every time)
                    */
                    text: O.bind( todo, 'summary' )
                })
            ]).end()
            // el( 'div.v-Todo-date', {
            //     text: O.bind( todo, 'start', function ( date ) {
            //         return date ? O.i18n.date( date, 'date', true ) : '';
            //     })
            // })
        ];
    },

    /* This method will trigger whenever you click on the View (or any of its
       child elements/views). Events are handled via delegation, and actual
       setup of the handler is done on class definition, so there is zero
       overhead when instantiating instances of TodoView.
    */
    select: function ( event ) {
        if ( !this.get( 'isSelected' ) ) {
            App.state.set( 'editTodo', null );
            App.selectedTodo.set( 'record', this.get( 'content' ) );
        }
        /* Stop propagation so the click handler on the root view isn't
           triggered.
        */
        event.stopPropagation();
    }.on( 'click' ),

    edit: function () {
        if ( !this.get( 'isEditing' ) ) {
            App.selectedTodo.set( 'record', this.get( 'content' ) );
            App.actions.edit();
        }
        event.stopPropagation();
    }.on( 'dblclick' ),

    stopEditing: function ( event ) {
        if ( this.get( 'isEditing' ) ) {
            var key = O.DOMEvent.lookupKey( event );
            if ( key === 'enter' || key === 'esc' ) {
                App.state.set( 'editTodo', null );
                event.stopPropagation();
            }
        }
    }.on( 'keydown' ),

    /* Handle dragging. When the user first starts to drag the view, this
       method is called. We'll record the initial position of the view, and
       pre-calculate the height. Then we turn animation on for all *other*
       instances of TodoView (we don't want to animate this one, as it's going
       to track the cursor).
    */
    dragStarted: function ( drag ) {
        var itemHeight = this.get( 'itemHeight' );
        drag.startY = this.get( 'index' ) * itemHeight;
        drag.maxY = ( this.getFromPath( 'list.length' ) - 1 ) * itemHeight;
        this.animateLayer = false;
        TodoView.prototype.animateLayer = true;
    },

    /* On move, update the position of this view, and work out if we have moved
       it to a new index in the list. If so, call the action to update the
       store. This will automatically update any affected views, and because
       animation is enabled, they will animate to their new positions.
    */
    dragMoved: function ( drag ) {
        var cursorPosition = drag.get( 'cursorPosition' ),
            startPosition = drag.get( 'startPosition' ),
            y = Math.max( 0, Math.min( drag.maxY,
                    drag.startY + ( cursorPosition.y - startPosition.y ) ) ),
            currentIndex = this.get( 'index' ),
            newIndex = Math.round( y / this.get( 'itemHeight' ) );
        if ( newIndex !== currentIndex ) {
            App.actions.reorderTodo(
                this.get( 'list' ), this.get( 'content' ), newIndex
            );
        }
        this.set( 'layout', y );
    },

    /* Cleanup on drag end */
    dragEnded: function () {
        delete this.animateLayer;
        TodoView.prototype.animateLayer = false;
        App.store.commitChanges();
    }
});

var appView = new O.View({
    className: 'v-App',
    childViews: [
        new O.LabelView({
            positioning: 'absolute',
            className: 'v-App-title',
            value: 'Todo'
        }),
        new O.ToolbarView({
            left: [
                new O.ButtonView({
                    icon: 'icon-plus-circle',
                    isDisabled: O.bind( App.state, 'isLoadingList' ),
                    label: 'New Todo',
                    shortcut: 'enter',
                    target: App.actions,
                    method: 'newTodo'
                }),
                new O.ButtonView({
                    icon: 'icon-rotate-left',
                    layout: { marginLeft: 10 },
                    isDisabled: O.bind( App.undoManager, 'canUndo',
                        O.Transform.invert ),
                    label: 'Undo',
                    /* Can define a keyboard shortcut directly on the button
                       it is equivalent to. The shortcut will be active so long
                       as the button is in the document. */
                    shortcut: 'cmd-z',
                    target: App.undoManager,
                    method: 'undo'
                })
            ],
            right: [
                new O.SearchTextView({
                    layout: { width: 200 },
                    placeholder: 'Search',
                    shortcut: '/',
                    value: O.bindTwoWay( App.state, 'search' )
                })
            ]
        }),
        new O.View({
            className: 'v-TodoList',
            draw: function (/* layer, Element, el */) {
                return [
                    new O.ListView({
                        content: O.bind( App.state, 'todos' ),
                        renderInOrder: false,
                        ItemView: TodoView,
                        itemHeight: 48
                    })
                ];
            }
        })
    ],
    newTodo: function ( target ) {
        if ( event.targetView === this ) {
            App.actions.newTodo();
        }
    }.on( 'dblclick' )
});

/* Insert the view we've constructred into the document */
App.views.mainWindow.insertView( appView );

/*  Because this setup code is not being run inside a run loop, we now need to
    flush all queues. Other than this, the queues will be managed completely
    automatically. A better option would be to wrap all of this setup code in

        O.RunLoop.invoke( function () {
            var App = {};
            ...
        });
    This will also mean you don't create any global variables. For demo purposes
    though, it's better to be able to inspect everything easily in the JS
    console.
*/
O.RunLoop.flushAllQueues();
