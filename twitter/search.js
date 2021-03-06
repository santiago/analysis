/*
 *  search.js
 *  Search out our dictionary on Twitter
 */

var redis = require('redis').createClient();
var twitter = require('ntwitter');

var esclient = (function() {
    var fork = true;
    if(fork) {
        return require('/Projects/node-elasticsearch-client');
    }
    return require('elasticsearchclient');
})();

// Initialize ES
var es = (function() {
    var opts = {
        host: 'localhost',
        port: 9200
    };

    return new (esclient)(opts);
})();

var accounts = require('./accounts'); // Twitter accounts we're using
var terms = [];
var windowLapse = 15 * 60 * 1000;
var rateLimit = 180;
var requestLapse = (windowLapse / rateLimit) / accounts.length;

(function getDictionary() {
    redis.smembers('dictionary', function(err, data) {
        redis.get('pointer', function(err, pointer) {
            terms = data.slice(pointer);
            run();
        });
    });    
});

(function getLocations() {
    redis.hgetall('municipios:location', function(err, data) {
        Object.keys(data).forEach(function(key) {
            var location = key.split(',');
//            terms.push({ 
//                query: location.slice(0,2).join(' '), 
//                term: key 
//            });
            terms.push({
                query: location[0],
                term: key,
                geocode: data[key],
                radius: '20km'
            });
        });
        run();
    });
})();

function run() {
    accounts.forEach(function(acc, i) {
        setTimeout(function() {
            new SearchAPI(acc);
        }, requestLapse * i);
    });
}

function storeEntities(entities) {
    var bulk = [];

    // Store entities in redis
    Object.keys(entities).forEach(function(type) {
        entities[type].forEach(function(item) {
            bulk = bulk.concat([
                { index: { _index: 'entities', _type: type } },
                item
            ]);
        });
    });

    if(bulk.length) {
        es.bulk(bulk, function(err, res) {
            // console.log(res);
        });            
    }
}

function store(data, q) {
    var bulk = [];

    // Store users and tweets in ES
    data.statuses.forEach(function(item) {
        if(item.lang != 'es')
            console.log(item.lang);
            
        if(!item.user) {
            console.log(item);
            return;
        }

        // Index users
        bulk = bulk.concat([
            { index: { _index: 'twitter', _type: 'user', _id: item.user.id_str+'' } },
            item.user
        ]);
        delete item.user;
        
        // The search term we used to find this tweet
        item.term = q;
        // Index tweets
        bulk = bulk.concat([
            { index: { _index: 'twitter', _type: 'tweet', _id: item.id_str+'' } },
            item
        ]);
        
        // Temporarily index to test/message
        var message = {
            id: item.id_str,
            created_at: (new Date(item.created_at)).toISOString(),
            text: item.text,
            term: item.term
        };
        bulk = bulk.concat([
            { index: { _index: 'geo', _type: 'message', _id: item.id_str+'' } },
            message
        ]);

        // Store entities in redis
//        storeEntities(item.entities);
    });
    
    if(bulk.length) {
        es.bulk(bulk, function(err, res) {
            // console.log(res);
        });            
    }
}

function updateHits(term, n) {
    redis.hincrby(term, 'hits', n);
}

function SearchAPI(acc) {
    this.twitter = new twitter(acc);
    this.search(terms.shift());
}

SearchAPI.prototype.next = function() {
    var delay = windowLapse / rateLimit;
    setTimeout(function() {
        var q = terms.shift();
        this.search(q);
        redis.incrby('pointer', 1);
    }.bind(this), delay);
};

SearchAPI.prototype.search = function(q) {
    if(typeof q == 'object') {
        // It's Geo search
        if(q.geocode) {
            this.geoSearch(q);
        } else {
            this.termSearch(q);
        }
    } else {
        this.next();
    }
};

SearchAPI.prototype.termSearch = function(q) {
    var api = this;

    this.twitter.search(q.query, { lang: 'es', count: 100 }, function(err, data) {
        api.next();

        if(err || !data) {
            console.log(err);
            return;
        }

        var n = data.statuses.length;
        
        console.log("\n\nTerm");
        console.log("============================================================================================");
        console.log(q);
        console.log(n);

        store(data, q.term);
        terms.push(q);
    });
};

SearchAPI.prototype.geoSearch = function(q) {
    var api = this;

    this.twitter.search('', { lang: 'es', count: 100, geocode: q.geocode+','+q.radius }, function(err, data) {
        api.next();

        if(err || !data) {
            console.log(err);
            return;
        }

        var n = data.statuses.length;

        console.log("\n\nGeo");
        console.log("============================================================================================");
        console.log(q);
        console.log(n);

        console.log(data.statuses.map(function(t) { return t.text; }));
        console.log(data.statuses.map(function(t) { return t.user.location; }));
        console.log();console.log();
    
        store(data, q.term);
        terms.push(q);
    });
};
