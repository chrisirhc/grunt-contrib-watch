module.exports = function(grunt) {
  'use strict';
  grunt.initConfig({
    echo: {
      files: [{
          src: ['lib/*.js']
      }]
    },
    incwatch: {
      files: '<%= echo.files[0].src %>',
      tasks: ['echo']
    }
  });
  // Load the echo task
  grunt.loadTasks('../tasks');
  // Load this watch task
  grunt.loadTasks('../../../tasks');
  grunt.registerTask('default', ['echo']);
};
