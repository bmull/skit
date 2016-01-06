'use strict';

/**
 * @license
 * (c) 2014 Cluster Labs, Inc. https://cluster.co/
 * License: MIT
 */

var path = require('path');
var util = require('util');

var Handlebars = require('handlebars');
var acorn = require('acorn');


var TargetEnvironment = {
  BROWSER: 'browser',
  SERVER: 'server'
};
module.exports.TargetEnvironment = TargetEnvironment;


function ScriptResource(filePath, resourcePath, source) {
  this.filePath = filePath;
  this.resourcePath = resourcePath;
  this.source = source;
}
module.exports.ScriptResource = ScriptResource;

ScriptResource.prototype.getRelativeDependencyPaths = function() {
  if (!this.relativeDependencyPaths_) {
    this.relativeDependencyPaths_ = this.findDependencyPaths_();
  }
  return this.relativeDependencyPaths_;
};

ScriptResource.prototype.getAbsoluteDependencyPaths = function() {
  return this.absoluteDependencyPaths_;
};
ScriptResource.prototype.setAbsoluteDependencyPaths = function(paths) {
  this.absoluteDependencyPaths_ = paths;
};

ScriptResource.prototype.getFunctionString = function() {
  if (!this.functionString_) {
    this.functionString_ = this.buildFunctionString_();
    this.cleanup_();
  }
  return this.functionString_;
};

ScriptResource.prototype.findDependencyPaths_ = function() {
  // TO OVERRIDE.
  return [];
};

ScriptResource.prototype.aliasForDependencyPath = function(dependencyPath) {
  return dependencyPath.replace(/[^a-zA-Z0-9_]/g, '_');
};

ScriptResource.prototype.buildFunctionString_ = function() {
  // TO OVERRIDE.
  return '(function(){})';
};

ScriptResource.prototype.includeInEnvironment = function(targetEnvironment) {
  // TO OVERRIDE.
  return true;
};

ScriptResource.prototype.cleanup_ = function() {
};

ScriptResource.prototype.bodyContentType = function() {
  var deps = this.getAbsoluteDependencyPaths();
  var body = [
    'skit.define(' + JSON.stringify(this.resourcePath) + ', ' + JSON.stringify(deps) + ', function() {',
    '  return (' + this.getFunctionString() + ').apply(this, arguments)',
    '});'
  ].join('');

  return {
    contentType: 'application/javascript',
    body: body,
  }
};


var ACORN_OPTIONS = {
  allowReturnOutsideFunction: true,
  // Does not work in older IE, so disallow here.
  allowTrailingCommas: false,
};

var JavaScriptResource = function() {
  ScriptResource.apply(this, arguments);
};
util.inherits(JavaScriptResource, ScriptResource);

JavaScriptResource.prototype.getParsedBody = function() {
  if (!this.parsed_) {
    try {
      this.parsed_ = acorn.parse(this.source, ACORN_OPTIONS);
    } catch(e) {
      e.fileName = this.filePath;
      if (e.loc) {
        e.lineNumber = e.loc.line;
      }
      console.log('Error parsing: ', e.fileName, e.lineNumber ? '(line ' + e.lineNumber + ')' : undefined);
      throw e;
    }
  }
  return this.parsed_.body;
};

JavaScriptResource.prototype.includeInEnvironment = function(environment) {
  if (!this.initializedIncluded_) {
    this.initializedIncluded_ = true;

    var parsedBody = this.getParsedBody();

    this.serverOnly_ = false;
    this.browserOnly_ = false;

    for (var i = 0; i < parsedBody.length; i++) {
      var node = parsedBody[i];
      if (node.type == 'ExpressionStatement' && node.expression.type == 'Literal') {
        var value = node.expression.value;
        if (value === 'server-only') {
          this.serverOnly_ = true;
        } else if (value === 'browser-only') {
          this.browserOnly_ = true;
        }
      } else {
        break;
      }
    }
  }

  if (this.browserOnly_) {
    return environment == TargetEnvironment.BROWSER;
  }

  if (this.serverOnly_) {
    return environment == TargetEnvironment.SERVER;
  }

  return true;
};

JavaScriptResource.prototype.findDependencyPaths_ = function() {
  var dependencies = [];

  var body = this.getParsedBody();
  for (var i = 0; i < body.length; i++) {
    var node = body[i];
    if (node.type != 'VariableDeclaration') {
      // Allows for 'use strict';
      if (node.type == 'ExpressionStatement' && node.expression.type == 'Literal') {
        continue;
      } else {
        break;
      }
    }

    var declarations = node.declarations;
    var gotAny = false;
    for (var j = 0; j < declarations.length; j++) {
      var declaration = declarations[j];
      if (!declaration.init || declaration.init.type != 'MemberExpression') {
        continue;
      }

      var dependency = this.source.substring(declaration.init.start, declaration.init.end);
      dependencies.push(dependency);
      gotAny = true;
    }

    if (!gotAny) {
      break;
    }
  }

  return dependencies;
};

var regexEscape = function(str) {
  return str.replace(/[\[\]\/\\{}()*+?.^$|-]/g, '\\$&');
};

JavaScriptResource.prototype.buildFunctionString_ = function() {
  var source = this.source;
  var depList = this.getRelativeDependencyPaths();

  var aliases = [];
  for (var i = 0; i < depList.length; i++) {
    var dependencyPath = depList[i];
    var alias = this.aliasForDependencyPath(dependencyPath);

    // Replace all foo.bar with foo_bar_12345 aliases, but only when
    // we know for sure it's an assignment situation.
    var regex = new RegExp('=\\s*' + regexEscape(dependencyPath) + '(?=\\s*(?:[,;]|$))', 'gm');
    source = source.split(regex).join('= ' + alias);

    aliases.push(alias);
  }

  // Note: I'm sorry. This is all on one line to keep
  // line numbers the same in generated code.
  source = [
    "var module = {exports: {}};",
    "var defined = null;",
    "function define() {",
    "  for (var i = 0; i < arguments.length; i++) {",
    "    if (typeof arguments[i] == 'function') { defined = arguments[i](); break; }",
    "  }",
    "}",
    "define.amd = true;",

    "var result = (function " + this.resourcePath.replace(/[^\w]/g,'_') + "() {",
  ].join(' ') + source + "})(); return result || defined || module.exports;";

  // Build a function with the given source, using aliases as arguments.
  // Then call the function with the actual objects in the correct order.
  var functionDefinition = '(function(' + aliases.join(',') + ') { ' + source + ' })';
  return functionDefinition;
};

JavaScriptResource.prototype.cleanup_ = function() {
  delete this.parsed_;
};



function HandlebarsResource() {
  ScriptResource.apply(this, arguments);
}
util.inherits(HandlebarsResource, ScriptResource);

HandlebarsResource.HANDLEBARS_MODULE = 'skit.thirdparty.handlebars';

HandlebarsResource.prototype.findDependencyPaths_ = function() {
  var deps = [HandlebarsResource.HANDLEBARS_MODULE];

  var source = this.source;
  var matcher = /\{\{>\s*([\w.]+)/g;
  var result;
  while (result = matcher.exec(source)) {
    deps.push(result[1]);
  }

  return deps;
};

HandlebarsResource.prototype.aliasForDependencyPath = function(dependencyPath) {
  if (dependencyPath == HandlebarsResource.HANDLEBARS_MODULE) {
    return 'Handlebars';
  }
  return ScriptResource.prototype.aliasForDependencyPath.call(this, dependencyPath);
};

HandlebarsResource.prototype.buildFunctionString_ = function() {
  var source = this.source;
  var depList = this.getRelativeDependencyPaths();

  var args = [];
  var partials = [];
  depList.forEach(function(dependencyPath) {
    var alias = this.aliasForDependencyPath(dependencyPath);
    source = source.split(dependencyPath).join(alias);
    args.push(alias);

    if (dependencyPath != HandlebarsResource.HANDLEBARS_MODULE) {
      // All other dependencies are partials.
      partials.push(alias);
    }
  }, this);

  // Don't look at me that way. I know. I KNOW!
  var partialDeclarations = partials.map(function(alias) {
    return JSON.stringify(alias) + ': ' + alias;
  });
  var partialMapString = '{' + partialDeclarations.join(',') + '}';

  var template;
  try {
    // TODO(Taylor): Allow other options to be passed in somehow.
    template = Handlebars.precompile(source, {
      preventIndent: true
    });

  } catch (e) {
    e.fileName = this.filePath;
    var lineNumberMatch = (e+'').match(/Parse error on line (\d+)/);
    if (lineNumberMatch) {
      e.lineNumber = +(lineNumberMatch[1]);
    }
    throw e;
  }

  var wrapped = [
    '(function(' + args.join(',') + ') {',
    '  var template = Handlebars.VM.template(' + template + ', Handlebars);',
    '  var partials = ' + partialMapString + ';' +
    '  return function(context, opt_options) {',
    '    var options = opt_options || {};',
    '    options.partials = partials;',
    '    return template(context, options);',
    '  }',
    '})'].join('\n');
  return wrapped;
};


function JSONResource() {
  ScriptResource.apply(this, arguments);
}
util.inherits(JSONResource, ScriptResource);

JSONResource.prototype.buildFunctionString_ = function() {
  return '(function(){ return ' + this.source + '; })';
};

JSONResource.prototype.includeInEnvironment = function(targetEnvironment) {
  if (typeof this.environment_ === 'undefined') {
    this.environment_ = JSON.parse(this.source)['__environment__'] || null;
  }

  if (this.environment_ && this.environment_ != targetEnvironment) {
    return false;
  }
  return true;
};


module.exports.ScriptResource = ScriptResource;
module.exports.JavaScriptResource = JavaScriptResource;
module.exports.HandlebarsResource = HandlebarsResource;
module.exports.JSONResource = JSONResource;


var RESOURCE_WRAPPERS = {};


function setResourceWrapper(extension, fn) {
  RESOURCE_WRAPPERS[extension] = fn;
}
module.exports.setResourceWrapper = setResourceWrapper;


function getResourceWrapper(extension) {
  return RESOURCE_WRAPPERS[extension] || null;
}
module.exports.getResourceWrapper = getResourceWrapper;


setResourceWrapper('.js', JavaScriptResource);
setResourceWrapper('.html', HandlebarsResource);
setResourceWrapper('.json', JSONResource);

