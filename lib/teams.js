// Deps
var
  request = require('request'),
  fs = require('fs'),
  us = require('underscore'),
  Promise = require('es6-promise').Promise,
  debug = require('debug')('showcase-teams'),

  OWNERS_ID = 20837789,
  // Cache the team data for a full minute
  CACHE_LIFE_CYCLE = process.env.CACHE_LIFE_CYCLE || 60 * 1000;

function compile (string, key) {
  return string.replace('@', key);
}

// Github endpoints ***
var gh = {
  teams: compile.bind(null, 'https://api.github.com/orgs/hackoutwest2016/teams'),
  members: compile.bind(null, 'https://api.github.com/teams/@/members'),
  repos: compile.bind(null, 'https://api.github.com/teams/@/repos'),
  thumnbnail: compile.bind(null, process.env.HOST_NAME + '/hackshots/@.png')
};

var options = {
  winnerIDs: JSON.parse(fs.readFileSync('./winners.json')),
  cache: null
};

// Request options
request = request.defaults({
  auth: {
    user: process.env.GH_USER,
    pass: process.env.GH_PASS
  },
  headers: {
    // Github best practices proposes this
    'User-Agent': 'wowhack-showcase'
  }
});

function populator (url, key, fn) {
  return new Promise(function (resolve) {
    debug('Sending populate request to ' + url);
    request.get(url, function (err, res, body) {
      var value = fn(body, (res || {}).statusCode);
      var result = {};
      result[key] = value;
      debug('Resolving request to ' + url + ' with ' + result);
      resolve(result);
    });
  });
}


// TODO, populate with repository data etc.
function populate (team) {
  debug('Populating team ' + team.id);
  var populators = [];

  // Add team members
  populators.push(populator(gh.members(team.id), 'members', function (body) {
    return JSON.parse(body);
  }));

  // Repo data
  populators.push(populator(gh.repos(team.id), 'repository', function (body) {
    return JSON.parse(body)[0] || {};
  }));

  // Image
  var tnUrl = gh.thumnbnail(team.slug);
  populators.push(populator(tnUrl, 'thumbnail', function (body, statusCode) {
    return statusCode === 200 ? tnUrl : '';
  }));

  debug('Waiting for ' + populators.length + ' populations to finish');


  // Collect all info and return
  return Promise.all(populators).then(function (objects) {
    debug('Collecting info for team ' + team.id);
    return us.extend.apply(us, [team].concat(objects));
  });
}

/*
  Set 'points' to sort from according to some weighted
  props, like description, thumbnail and homepage.
*/
function calculateSortPoints(team) {
  debug('Calculating sorting bonus points');

  var weights = [
    { prop: 'homepage',     weight: 1 },
    { prop: 'description',  weight: 2 }
  ];

  team.points = weights.reduce(function(points, obj) {
    points += !!team.repository[obj.prop] ? obj.weight : 0;
    return points;
  }, 0);

  team.points += !!team.thumbnail ? 3 : 0;

  return team;
}

// Fetch and group teams by winners and others
function loadTeams (callback) {
  debug('Fetching teams');
  request.get(gh.teams(), function (err, res, body) {
    var teams;
    try {
      teams = JSON.parse(body);
    } catch (e) {
      return callback({ error: e });
    }

    // Exclude owner team
    teams = us.reject(teams, function (team) {
      return team.id === OWNERS_ID;
    });

    var populationRequests = teams.map(populate);

    debug('Waiting for ' + populationRequests + ' FULL populations to finish');
    Promise.all(populationRequests)
    .then(function(teams) {
      return teams.map(calculateSortPoints);
    })
    .then(function (teams) {
      debug('All populations finished, found ' + teams.length + ' teams');
      var winners = [];
      var others = [];

      // Categorize winning teams
      teams.forEach(function (team) {
        if (options.winnerIDs.indexOf(team.id) >= 0) {
          winners.push(team);
        } else {
          others.push(team);
        }
      });
      //stupid reverse to get the order of the winner correct.
      winners.reverse();
      // We know the outcome :)
      console.assert(winners.length === 3, winners);

      // Sort the hacks
      others.sort(function(a, b) {
        return b.points - a.points;
      });

      // TODO We should cache the result and send modified since headers
      var result = {
        winners: winners,
        others: others
      };

      options.cache = result;
      setTimeout(function () {
        options.cache = null;
      }, CACHE_LIFE_CYCLE);

      callback(result);
    });
  });
}

module.exports = {
  loadTeams: function (callback) {
    if (options.cache) {
      debug('Serving cached team data');
      callback(options.cache);
    } else {
      debug('Serving new team data');
      loadTeams(callback);
    }
  }
};
