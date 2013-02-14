/*
 * grunt-incremental
 * Copyright (c) 2013 Chris Chua, contributors
 *
 * Forked from https://github.com/gruntjs/grunt-contrib-watch
 * Copyright (c) 2012 "Cowboy" Ben Alman, contributors
 * Licensed under the MIT license.
 */

module.exports = function(grunt) {
  'use strict';

  var path = require('path');
  var fs = require('fs');
  var Gaze = require('gaze').Gaze;

  // Default options for the watch task
  var defaults = {
    interrupt: false
  };

  var defaultTask = 'incwatch',
      startTask   = defaultTask + ':start',
      endTask     = defaultTask + ':end';

  var changeCodesToTypes = {
    A: 'added',
    D: 'deleted',
    C: 'changed'
  };
  var changeTypesToCodes = {};
  Object.keys(changeCodesToTypes).forEach(function (code) {
    changeTypesToCodes[ changeCodesToTypes[code] ] = code;
  });

  var workingDirectory = '.grunt/grunt-incremental/';

  function getChangesFilePath(targetName) {
    return workingDirectory + '.' + defaultTask + (targetName && targetName.length > 0 ? '-' + targetName : '');
  }

  var changesQueue = grunt.util.async;

  function initWorkingDir() {
    var dirs = workingDirectory.split('/');
    dirs.forEach(function (dir, i) {
      var subpath = path.join.apply(path, dirs.slice(0, i+1));
      if (!fs.existsSync(subpath)) {
        fs.mkdirSync(subpath);
      }
    });
  }

  function writeChanges(targetName, status, filepath) {
    grunt.log.debug('Writing changes into ' + getChangesFilePath(targetName));
    // TODO: Not sure if I should be ignoring the --no-write option here
    fs.appendFileSync(getChangesFilePath(targetName), changeTypesToCodes[status] + ' ' + filepath + '\n');
  }

  function readChanges(targetName) {
    var changesFileName = getChangesFilePath(targetName);
    grunt.log.debug('Reading changes from ' + changesFileName);
    var changesStr = fs.existsSync(changesFileName) ? fs.readFileSync(changesFileName, 'utf-8') : '';
    var changes = changesStr.split('\n')
                  .filter(function (el) {
                    return el && el !== '';
                  })
                  .map(function (el) {
                    var changeCode = el[0];
                    var filepath = el.substr(2);
                    var changeType = changeCodesToTypes[ changeCode ];
                    return {
                      type: changeType,
                      filepath: filepath
                    };
                  });
    return changes;
  }

  function clearChanges(targetName) {
    var changesFileName = getChangesFilePath(targetName);
    grunt.log.debug('Clearing changes from ' + changesFileName);
    grunt.file.delete(changesFileName);
  }

  function modifyTask(taskName, addedOrChangedFilePaths) {
    function findMatching(fileConfig) {
      var newFileConfig = [];
      fileConfig.forEach(function (mapping) {
        var newSrc;
        // One to one
        if (mapping.src.length === 1) {
          if ( addedOrChangedFilePaths.indexOf(mapping.src[0]) !== -1) {
            newFileConfig.push({ src: mapping.src, dest: mapping.dest });
          }
        }
        // Many to one
        else {
          var intersect = grunt.util._.intersection(mapping.src, addedOrChangedFilePaths);
          if (intersect.length > 0) {
            // When it's all to src, or to a folder use only the intersect
            if (mapping.dest === 'src' || grunt.file.isDir(mapping.dest)) {
              newFileConfig.push({ src: intersect, dest: mapping.dest });
            } else {
              newFileConfig.push({ src: mapping.src, dest: mapping.dest });
            }
          }
        }
        // TODO: Support deleted files. It should rebuild the files that might've used it.
      });
      return newFileConfig;
    }
    // TODO: Check if this is the proper way of obtaining settings
    var fileConfigKey = taskName.replace(/:/g, '.');
    var fileConfig = grunt.config(fileConfigKey);
    grunt.log.debug('Modifying files in ', fileConfigKey);
    fileConfig = grunt.task.normalizeMultiTaskFiles(fileConfig);
    if (fileConfig && Array.isArray(fileConfig) && fileConfig.length > 0) {
      // Replace the file options
      grunt.config(fileConfigKey + '.files', findMatching(fileConfig));
      var fullConfig = grunt.config(fileConfigKey);
      // Remove src and dest if specified
      delete fullConfig.src;
      delete fullConfig.dest;
    }
  }

  var changesRead = null;

  grunt.registerTask(defaultTask, 'Run predefined tasks whenever watched files change.', function(target, targetName) {
    var name = this.name || defaultTask;

    if (target === 'start') {
      name = targetName || '';
      changesRead = readChanges(name);
      var filePaths = {};
      Object.keys(changeTypesToCodes).forEach(function (changeType) {
        filePaths[changeType] = changesRead
                                .filter(function (change) {
                                  return change.type === changeType;
                                })
                                .map(function (change) {
                                  return change.filepath;
                                });
      });
      var addedOrChangedFilePaths = filePaths['added'].concat(filePaths['changed']);
      var targetConfigKey = defaultTask + (name ? '.' + name : '') ;
      grunt.config(targetConfigKey + '.changes', changesRead);
      grunt.config(targetConfigKey + '.filePaths', filePaths);

      // Get subtasks
      var tasks = grunt.config(targetConfigKey + '.tasks');
      // Get tasks from config and iterate through their configuration to feed in only changed files
      tasks.forEach(function (task) {
        modifyTask(task, addedOrChangedFilePaths);
      });
      return;
    } else if (target === 'end') {
      name = targetName || '';

      // Remove the watch target file
      clearChanges(name);
      return;
    }

    initWorkingDir();
    this.requiresConfig(name);

    // Build an array of files/tasks objects
    var watch = grunt.config(name);
    var targets = target ? [target] : Object.keys(watch).filter(function(key) {
      return typeof watch[key] !== 'string' && !Array.isArray(watch[key]);
    });

    targets = targets.map(function(target) {
      // Fail if any required config properties have been omitted
      var targetName = target;
      target = [name, target];
      this.requiresConfig(target.concat('files'), target.concat('tasks'));
      return grunt.util._.extend( grunt.config(target), {name: targetName} );
    }, this);

    // Allow "basic" non-target format
    if (typeof watch.files === 'string' || Array.isArray(watch.files)) {
      targets.push({files: watch.files, tasks: watch.tasks});
    }

    // Message to display when waiting for changes
    var waiting = 'Waiting...';

    // File changes to be logged.
    var changedFiles = Object.create(null);

    // Keep track of spawns per tasks
    var spawned = Object.create(null);

    // List of changed / deleted file paths.
    grunt.file.watchFiles = {changed: [], deleted: [], added: []};

    // Get process.argv options without grunt.cli.tasks to pass to child processes
    var cliArgs = grunt.util._.without.apply(null, [[].slice.call(process.argv, 2)].concat(grunt.cli.tasks));

    // Call to close this task
    var done = this.async();
    grunt.log.write(waiting);

    // Run the tasks for the changed files
    var runTasks = grunt.util._.debounce(function runTasks(i, tasks, options) {
      // If interrupted, reset the spawned for a target
      if (options.interrupt && typeof spawned[i] === 'object') {
        grunt.log.writeln('').write('Previously spawned task has been interrupted...'.yellow);
        spawned[i].kill('SIGINT');
        delete spawned[i];
      }

      // Only spawn one at a time unless interrupt is specified
      if (!spawned[i]) {
        grunt.log.ok();

        var fileArray = Object.keys(changedFiles);
        fileArray.forEach(function(filepath) {
          // Log which file has changed, and how.
          grunt.log.ok('File "' + filepath + '" ' + changedFiles[filepath] + '.');
        });

        // Reset changedFiles
        changedFiles = Object.create(null);

        // Spawn the tasks as a child process
        var start = Date.now();
        spawned[i] = grunt.util.spawn({
          // Spawn with the grunt bin
          grunt: true,
          // Run from current working dir and inherit stdio from process
          opts: {cwd: process.cwd(), stdio: 'inherit'},
          // Run grunt this process uses, append the task to be run and any cli options
          args: grunt.util._.union(tasks, cliArgs)
        }, function(err, res, code) {
          // Spawn is done
          delete spawned[i];
          var msg = String(
            'Completed in ' +
            Number((Date.now() - start) / 1000).toFixed(2) +
            's at ' +
            (new Date()).toString()
          ).cyan;
          grunt.log.writeln('').write(msg + ' - ' + waiting);
        });
      }
    }, 250);

    targets.forEach(function(target, i) {
      if (typeof target.files === 'string') {
        target.files = [target.files];
      }

      // Process into raw patterns
      var patterns = grunt.util._.chain(target.files).flatten().map(function(pattern) {
        return grunt.config.process(pattern);
      }).value();

      // Default options per target
      var options = grunt.util._.defaults(target.options || {}, defaults);

      // TODO: Start task may need to be right before each task to do incremental build
      target.tasks.unshift(startTask + (target.name ? ':' + target.name : ''));
      target.tasks.push(endTask + (target.name ? ':' + target.name : ''));

      // Create watcher per target
      var gaze = new Gaze(patterns, options, function(err) {
        if (err) {
          grunt.log.error(err.message);
          return done();
        }

        // On changed/added/deleted
        this.on('all', function(status, filepath) {
          filepath = path.relative(process.cwd(), filepath);
          writeChanges(target.name, status, filepath);
          changedFiles[filepath] = status;
          runTasks(i, target.tasks, options);
        });

        // On watcher error
        this.on('error', function(err) { grunt.log.error(err); });
      });
    });

    // Keep the process alive
    setInterval(function() {}, 250);
  });
};
