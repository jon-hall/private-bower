var PackageStore = require('./package-store');
var PublicPackageStore = require('./public-package-store');
var RepoCache = require('./repo-cache');

var argv = require('optimist').argv;
var fs = require('fs');
var path = require('path');
var log4js = require('log4js');
var bodyParser = require('body-parser');
var express = require('express');
var app = express();

var logger = require('./logger');

var _config, _configDirectory;
var _repoCacheEnabled;
var _packageStore, _publicPackageStore, _repoCache;

module.exports.run = _init;
function _init() {
    if(argv.h || argv.help) {
        logger.logHelp();

        process.exit();
    }

    _loadConfig();

    _repoCacheEnabled = _config.repositoryCache && _config.repositoryCache.enabled;

    _packageStore = new PackageStore({
        persistFilePath: _config.registryFile
    });

    if(!_config.disablePublic) {
        _publicPackageStore = new PublicPackageStore(_config);

        if(_repoCacheEnabled) {
            _repoCache = new RepoCache({
                repoCacheRoot: path.resolve(_config.repositoryCache.cacheDirectory || path.join(_configDirectory, './repoCache')),
                hostName: _config.repositoryCache.gitHost || 'git://localhost',
                port: _config.repositoryCache.gitPort || 6789
            });
        }
    }

    _initService();
}

function _loadConfig() {
    var configPath = path.resolve(argv.config || '../bower.conf.json');

    if(!fs.existsSync(configPath)) {
        logger.log('config file not found at '.red + configPath);
    }

    _configDirectory = path.join(configPath, '../');

    var json = fs.readFileSync(configPath).toString();
    _config = JSON.parse(json);

    //defaults
    _config.port = _config.port || 5678;
    _config.registryFile = path.resolve(_config.registryFile || path.join(_configDirectory, './bowerRepository.json'));

    if(_config.log4js && _config.log4js.enabled)  {
        log4js.configure(_config.log4js.configPath);
    }
}

function _initService() {
    app.use(bodyParser());
    app.use(express.static(path.join(__dirname, '../site')));

    app.post('/registerPackage', function(req, res) {
        _packageStore.registerPackages([
            {
                name: req.body.name,
                repo: req.body.repo
            }
        ], true);

        res.send('ok');
    });

    app.post('/packages', function(req, res) {
        _packageStore.registerPackages([
            {
                name: req.body.name,
                repo: req.body.url
            }
        ]);

        res.send(201);
    });

    app.post('/registerPackages', function(req, res) {
        _packageStore.registerPackages(req.body.packages, true);

        res.send('ok');
    });

    app.post('/removePackage', function(req, res) {
        _packageStore.removePackages([ req.body.name ]);

        res.send('ok');
    });

    app.post('/removePackages', function(req, res) {
        _packageStore.removePackages(req.body.packages);

        res.send('ok');
    });

    app.get('/packages', function(req, res) {
        var packages = [];

        for(var packageName in _packageStore.packages) {
            if(_packageStore.packages.hasOwnProperty(packageName)) {
                var item = _packageStore.packages[packageName];

                packages.push({
                    name: packageName,
                    repo: item.repo,
                    hits: item.hits
                });
            }
        }

        res.send(packages);
    });

    app.get('/packages/search/:name', function(req, res) {
        var searchName = req.params.name;

        var packages = _packageStore.searchPackage(searchName);

        if(!_config.disablePublic) {
            Array.prototype.push.apply(packages, _publicPackageStore.searchPackage(searchName));
        }

        res.send(packages);
    });

    // Caching of debounced requests
    var _activeRepoRequests = {};

    // When a package is ready to send to any debounced clients we call this
    function _replyToRepoRequests(name, data, responseStatus) {
        if(_activeRepoRequests[name] && _activeRepoRequests[name].length) {
            _activeRepoRequests[name].forEach(function(res) {
                if(responseStatus) {
                    res.status(responseStatus);
                }

                res.send(data);
            });

            // Now that all of the debounced connections have had a response, drop them
            delete _activeRepoRequests[name];
        }
    }

    //bower service
    app.get('/packages/:name', function(req, res) {
        var name = req.params.name;
        var cachedOrPrivatePackage = _packageStore.getPackage(name);

        // We check the existence of the key for this repo rather than length because the close
        // listener above results in length usually being 1, but while we're debouncing the array
        // always EXISTS
        var debouncing = !!_activeRepoRequests[name];

        // Add this request onto the debounce queue, whether debouncing or not
        _activeRepoRequests[name] = _activeRepoRequests[name] || [];
        _activeRepoRequests[name].push(res);

        // When this request times out, remove it from the debounce queue
        req.on('close', function() {
            var index;
            if(_activeRepoRequests[name] && _activeRepoRequests[name].length) {
                if((index = _activeRepoRequests[name].indexOf(res)) >= 0) {
                    _activeRepoRequests[name].splice(index, 1);
                }
            }
        });

        if(debouncing) {
            // Ignore the request, get on with life
            return;
        }

        if(cachedOrPrivatePackage) {
            cachedOrPrivatePackage = {
                name: name,
                url: cachedOrPrivatePackage.repo,
                hits: cachedOrPrivatePackage.hits,
                private: cachedOrPrivatePackage.private
            };

            if(cachedOrPrivatePackage.private) {
                // Private (possibly also cached
                if(!_repoCacheEnabled || !_config.repositoryCache.cachePrivateRepos) {
                    // Not caching private packages so just send back the uncached private package
                    _replyToRepoRequests(name, cachedOrPrivatePackage);
                    return;
                }
            }

            // TODO: Only caching private?
            // Public (cached) or private (cached) package, try to get it out the cache
            _tryGetCachedRepo(name, cachedOrPrivatePackage)
                .then(function (cachedPackage) {
                    _replyToRepoRequests(name, cachedPackage);
                })
                .fail(function () {
                    _replyToRepoRequests(name, cachedOrPrivatePackage);
                });

            return;
        }

        if(!_config.disablePublic) {
            var publicPackage = _publicPackageStore.getPackage(name);
            if(publicPackage) {
                if(_repoCacheEnabled) {
                    _tryGetCachedRepo(name, publicPackage)
                        .then(function(cachedPackage) {
                            _replyToRepoRequests(name, cachedPackage);
                        })
                        .fail(function() {
                            _replyToRepoRequests(name, publicPackage);
                        });
                }
                else {
                    _replyToRepoRequests(name, publicPackage);
                }
            }
        }
        else {
            _replyToRepoRequests(name, 'Not found', 404);
        }
    });

    function _tryGetCachedRepo(repoName, existingPackage) {
        // Coalesce url (public packages) with repo (private packages)
        return _repoCache.getCachedRepo(repoName, existingPackage.url || existingPackage.repo)
            .then(function(pack) {
                var cachedPackage = {
                    name: repoName,
                    repo: pack.repo,
                    hits: existingPackage.hits,
                    private: existingPackage.private
                };

                // Register the package if required (e.g. it was newly cloned)
                if(pack.requiresRegistration) {
                    _packageStore.registerPackages([ cachedPackage ]);
                }

                // Make sure we send the client 'url' not 'repo'
                cachedPackage.url = cachedPackage.repo;
                delete cachedPackage.repo;

                return cachedPackage;
            });
    }

    app.listen(_config.port, function() {
        logger.log('Bower server started on port ' + _config.port);
    });
}

