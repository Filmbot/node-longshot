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
    }
  } );
  playbook.on( 'stderr', function ( data ) {
    if ( defaultConfig.verbose ) {
      console.log( data.toString().red );
    }

    slackWebhook.send( {
      attachments: [ {
        color: '#D50200',
        fallback: '```' + data.toString() + '```',
        text: data.toString()
      } ]
    } );
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

function playbookSuccess ( res ) {
  if ( defaultConfig.verbose ) {
    console.log( '****** [SUCCESS] ******'.bold.green );
    console.log( res.output.toString().bold.green );
  }

  slackWebhook.send( {
    attachments: [ {
      color: '#36a64f',
      pretext: 'Success! Deploy Details: ' + lc.playbookName,
      fallback: '*Deploy Details: ' + lc.playbookName + '*' + '\n' + '```' + res.output.toString() + '```',
      text: res.output.toString()
    } ]
  } );
}

function playbookError ( err ) {
  if ( defaultConfig.verbose ) {
    console.error( '****** [ERROR] ******'.bold.red );
    console.error( err.toString().bold.red );
  }

  slackWebhook.send( {
    attachments: [ {
      color: '#D50200',
      pretext: 'Error! Deploy Details: ' + lc.playbookName,
      fallback: '*Deploy Details: ' + lc.playbookName + '*' + '\n' + '```' + res.output.toString() + '```',
      text: err.toString()
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
		var data = arguments[ arguments.length - 1 ];

		if ( defaultConfig.verbose ) {
			console.log( (
			'Running [' + lc.playbookName + '] on: ' +
			data.repository.full_name + ':' + data.ref + '#' + data.after ).cyan );
		}

		// ensure projectDir is up to date
		bootstrapPlaybook
			.exec( {
				cwd: ansibleConfig.playbookDir
			} )
			.then( function ( res ) {
        playbookSuccess( res );

				playbook
					.variables( {
						repo_url: data.repository.ssh_url,
						repo_ref: data.ref,
						repo_sha: data.after
					} )
					.exec( {
						cwd: ansibleConfig.playbookDir
					} )
					.then(playbookSuccess, playbookError);
			}, playbookError );

	} );
} );
