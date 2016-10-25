#!/usr/bin/env node

/* jshint: nodejs */
'use strict;';

var githubhook = require('githubhook'),
  config = require('config'),
  Ansible = require('node-ansible'),
  extend = require('extend'),
  path = require('path'),
	colors = require('colors');

var listenersConfig = config.get('listeners'),
  ansibleConfig = extend({
    playbookDir: './',
    inventoryDir: './inventory/',
    verbosity: null
  }, config.get('ansible')),
  envConfig = extend({
  }, config.get('env')),
  defaultConfig = extend({
    verbose: false
  }, config.get('default')),
  githubhookConfig = extend({
    path: '/longshot',
    logger: (!!defaultConfig.verbose ? console : null),
  }, config.get('githubhook'));

extend(process.env, envConfig);

Object.keys(listenersConfig).reduce(function(acc, k) {
  acc[k] = extend({
    event: '*',
    reponame: '*',
    ref: '*',
    playbookName: null,
    hostLimit: null,
    tags: null,
    skipTags: null
  }, acc[k]);
}, listenersConfig);

var github = githubhook(githubhookConfig);

github.listen();

Object.keys(listenersConfig).forEach(function(k) {
  var lc = listenersConfig[k],
    pattern = [lc.event, lc.reponame, lc.ref].filter(function(c) {
      return !!c && c !== '*';
    }).join(':'),
    playbook = new Ansible.Playbook()
      .playbook(lc.playbookName)
      .inventory(path.join(ansibleConfig.inventoryDir, lc.inventoryName));

	if (defaultConfig.verbose) {
		playbook.on('stdout', function(data) {
			console.log(data.toString().cyan);
		});
		playbook.on('stderr', function(data) {
			console.log(data.toString().red);
		});
	}

  if (!!defaultConfig.verbose) {
    playbook = playbook.verbose('vvvv');
  }

  if (!!lc.hostLimit) {
    playbook = playbook.limit(lc.hostLimit);
  }
  if (!!lc.tags) {
    playbook = playbook.tags(lc.tags);
  }
  if (!!lc.skipTags) {
    playbook = playbook.skipTags(lc.skipTags);
  }

  github.on(pattern, function() {
    var data = arguments[arguments.length - 1];

		console.log(('Running [' + lc.playbookName + '] on: ' + data.repository.full_name + ':' + data.ref + '#'  + data.after).cyan);

    playbook
      .variables({
        repo_url: data.repository.ssh_url,
        repo_ref: data.ref,
        repo_sha: data.after
      })
      .exec({
        cwd: ansibleConfig.playbookDir
      })
			.then(function(res) {
				console.log('****** [SUCCESS] ******'.bold.green);
				console.log(res.output.toString().bold.green);
			}, function(err) {
				console.error('****** [ERROR] ******'.bold.red);
				console.error(err.toString().bold.red);
			});
  });
});
