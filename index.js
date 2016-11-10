#!/usr/bin/env node

/* jshint: nodejs */
'use strict;';

var githubhook = require( 'githubhook' ),
	config = require( 'config' ),
	Ansible = require( 'node-ansible' ),
	extend = require( 'extend' ),
	path = require( 'path' ),
	colors = require( 'colors' ),
	slack = require( '@slack/client' );

var listenersConfig = config.get( 'listeners' ),
	ansibleConfig = extend( {
		projectDir: './',
		playbookDir: './ansible/',
		inventoryDir: './ansible/inventory/',
		verbosity: null
	}, config.get( 'ansible' ) ),
	envConfig = extend( {
	}, config.get( 'env' ) ),
	defaultConfig = extend( {
		verbose: false
	}, config.get( 'default' ) ),
	githubhookConfig = extend( {
		host: '0.0.0.0',
		port: 3402,
		secret: '',
		wildcard: false,
		path: '/longshot',
		logger: ( !!defaultConfig.verbose ? console : null ),
	}, config.get( 'githubhook' ) ),
	slackConfig = extend( {
		webhookUrl: null,
		username: 'Longshot',
		iconUrl: null
	}, config.get( 'slack' ) );
// copy env config into the env
extend( process.env, envConfig );
// default all listerners
Object.keys( listenersConfig ).reduce( function ( acc, k ) {
	acc[ k ] = extend( {
		event: '*',
		reponame: '*',
		ref: '*',
		playbookName: null,
		hostLimit: null,
		tags: null,
		skipTags: null
	}, acc[ k ] );
}, listenersConfig );

// instantiate slack and github
var slackWebhook = new slack.IncomingWebhook( slackConfig.webhookUrl, slackConfig ),
	github = githubhook( githubhookConfig );

// start github
github.listen();

function configurePlaybook ( playbook, lc ) {
	playbook = playbook.inventory( path.join( ansibleConfig.inventoryDir, lc.inventoryName ) );

	playbook.on( 'stdout', function ( data ) {
		if ( defaultConfig.verbose ) {
			console.log( data.toString().cyan );
			slackWebhook.send( {
				attachments: [ {
					mrkdwn_in: [ 'text' ],
					color: '#00FFFF',
					text: '```' + data.toString() + '```'
				} ]
			} );
		}
	} );

	playbook.on( 'stderr', function ( data ) {
		if ( defaultConfig.verbose ) {
			console.log( data.toString().red );
			slackWebhook.send( {
				attachments: [ {
					mrkdwn_in: [ 'text' ],
					color: '#FF00FF',
					text: '```' + data.toString() + '```'
				} ]
			} );
		}
	} );

	if ( !!defaultConfig.verbose ) {
		playbook = playbook.verbose( 'vvvv' );
	}

	if ( !!lc.hostLimit ) {
		playbook = playbook.limit( lc.hostLimit );
	}

	if ( !!lc.tags ) {
		playbook = playbook.tags( lc.tags );
	}

	if ( !!lc.skipTags ) {
		playbook = playbook.skipTags( lc.skipTags );
	}
	return playbook;

}

function truncateForSlack ( txt ) {
	if ( !txt ) return '';

    txt = txt.replace("\\n", "\n");

	if ( txt.length > 7000 ) {
		txt = "[ Output truncated... ]" + "\n\n" + txt.substring( txt.length - 7000, txt.length );
	}

	return txt;
}

function playbookSuccess ( res, lc ) {
	if ( defaultConfig.verbose ) {
		console.log( '****** [SUCCESS] ******'.bold.green );
		console.log( res.output.toString().bold.green );
	}

	slackWebhook.send( {
		attachments: [ {
			mrkdwn_in: [ 'text', 'pretext' ],
			color: '#36a64f',
			pretext: '[SUCCESS] *[' + lc.playbookName + ']*',
			text: '```' + truncateForSlack( res.output.toString() ) + '```',
            ts: parseInt(new Date().getTime()/1000, 10)
		} ]
	} );
}

function playbookError ( err, lc ) {
	if ( defaultConfig.verbose ) {
		console.error( '****** [ERROR] ******'.bold.red );
		console.error( err.toString().bold.red );
	}

	slackWebhook.send( {
		attachments: [ {
			mrkdwn_in: [ 'text', 'pretext' ],
			color: '#D50200',
			pretext: '[ERROR] *[' + lc.playbookName + ']*',
			text: '```' + truncateForSlack( err.toString() ) + '```',
            ts: parseInt(new Date().getTime()/1000, 10)
		} ]
	} );
}

// set up github listeners
Object.keys( listenersConfig ).forEach( function ( k ) {
	var lc = listenersConfig[ k ],
		pattern = [ lc.event, lc.reponame, lc.ref ].filter( function ( c ) {
			return !!c && c !== '*';
		} ).join( ':' ),
		playbook = configurePlaybook( new Ansible.Playbook().playbook( lc.playbookName ), lc ),
		bootstrapPlaybook = configurePlaybook( new Ansible.Playbook().playbook( ansibleConfig.bootstrapPlaybook ), lc );

	github.on( pattern, function () {
		var data = arguments[ arguments.length - 1 ],
			beginMsg = 'Running [' + lc.playbookName + '] on: ' + data.repository.full_name + ':' + data.ref + '#' + data.after;
		if ( defaultConfig.verbose ) {
			console.log( beginMsg.cyan );
		}
		slackWebhook.send( beginMsg );

		// ensure projectDir is up to date
		bootstrapPlaybook
			.variables( {
				restart_service: false,
				repo_url: data.repository.ssh_url,
				repo_ref: data.ref,
				repo_sha: data.after
			} )
			.exec( {
				cwd: ansibleConfig.playbookDir
			} )
			.then( function ( res ) {
				playbook
					.variables( {
						repo_url: data.repository.ssh_url,
						repo_ref: data.ref,
						repo_sha: data.after
					} )
					.exec( {
						cwd: ansibleConfig.playbookDir
					} )
					.then( function ( res ) {
						playbookSuccess( res, lc );
					}, function ( err ) {
						playbookError( err, lc );
					} );
			}, function ( err ) {
				playbookError( err, lc );
			} );

	} );
} );
