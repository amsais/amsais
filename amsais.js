var AisDecode  = require ("ggencoder").AisDecode;
var readline = require('readline');
var geolib = require('geolib');
var fs = require('fs'); 
var parse = require('csv-parse');
var Twit = require('twit');
var request = require('request');
var fs = require('fs');
var clone = require('clone');

var config = require('./config');


// twitter API config
var T = new Twit({
    consumer_key: config.twitter.consumer_key
  , consumer_secret: config.twitter.consumer_secret
  , access_token: config.twitter.access_token
  , access_token_secret: config.twitter.access_token_secret
});


// some config
var timelimit = 300;
var speedlimit = 6;
var ignorediff = 3;
var minn = 4;
var speedchecklimit = 1

// some state
var boats = {};
var tweetcand = {kmhrep: 0};
var session = {}; 

// read rondvaart boat metadata
fs.createReadStream('b0ats.csv')
    .pipe(parse({delimiter: ','}))
    .on('data', function(csvrow) {
		boats[csvrow[4]] = {mmsi : csvrow[4], name: csvrow[2], company: csvrow[1], 
			twitter: csvrow[5], permit: csvrow[3], lastn: []}      
    });

// geofence where the 6 km/h speed limit is in force
var slowzoneams1 = [{longitude:4.8862553,latitude:52.3902944}, {longitude:4.8838949,latitude:52.3854751}, {longitude:4.8810625,latitude:52.3817031}, {longitude:4.8751402,latitude:52.38021}, {longitude:4.8720503,latitude:52.3767781}, {longitude:4.8624802,latitude:52.3661403}, {longitude:4.8552275,latitude:52.357125}, {longitude:4.8517942,latitude:52.3470592}, {longitude:4.8503351,latitude:52.3439394}, {longitude:4.850378,latitude:52.3415797}, {longitude:4.8533821,latitude:52.3395345}, {longitude:4.8796892,latitude:52.3407669}, {longitude:4.8874569,latitude:52.3402687}, {longitude:4.8886156,latitude:52.3473738}, {longitude:4.89604,latitude:52.3469543}, {longitude:4.90973,latitude:52.348737}, {longitude:4.909215,latitude:52.3501526}, {longitude:4.907198,latitude:52.3528787}, {longitude:4.904151,latitude:52.3567318}, {longitude:4.902606,latitude:52.3607418}, {longitude:4.8997307,latitude:52.3662451}, {longitude:4.901619,latitude:52.3667168}, {longitude:4.9025202,latitude:52.3665072}, {longitude:4.9057388,latitude:52.3671099}, {longitude:4.9071121,latitude:52.3680532}, {longitude:4.9118757,latitude:52.3712761}, {longitude:4.9108458,latitude:52.3715381}, {longitude:4.912219,latitude:52.3729792}, {longitude:4.912262,latitude:52.374394}, {longitude:4.910717,latitude:52.374656}, {longitude:4.9097729,latitude:52.3753634}, {longitude:4.9053526,latitude:52.3776951}, {longitude:4.8974991,latitude:52.3805243}, {longitude:4.8938084,latitude:52.3824366}, {longitude:4.8932076,latitude:52.3829605}, {longitude:4.8928642,latitude:52.3862347}, {longitude:4.8916626,latitude:52.3889587}, {longitude:4.890976,latitude:52.389692}, {longitude:4.8862553,latitude:52.3902944}];

var slowzoneams2 = [{longitude:4.9134636,latitude:52.3770663}, {longitude:4.9147511,latitude:52.3741844}, {longitude:4.9170685,latitude:52.3739748}, {longitude:4.9174976,latitude:52.3726648}, {longitude:4.9156952,latitude:52.3713547}, {longitude:4.9136353,latitude:52.3705687}, {longitude:4.9089146,latitude:52.3676339}, {longitude:4.9060822,latitude:52.3660617}, {longitude:4.9029064,latitude:52.3655376}, {longitude:4.9055672,latitude:52.3597721}, {longitude:4.9065113,latitude:52.3586189}, {longitude:4.9228191,latitude:52.3621832}, {longitude:4.9276257,latitude:52.3654328}, {longitude:4.9560356,latitude:52.3661141}, {longitude:4.9552631,latitude:52.3685249}, {longitude:4.9380112,latitude:52.3684725}, {longitude:4.9380112,latitude:52.3709355}, {longitude:4.9288273,latitude:52.3745512}, {longitude:4.9202442,latitude:52.3761232}, {longitude:4.9134636,latitude:52.3770663}];


function median(values) {
    values.sort( function(a,b) {return a - b;} );
    var half = Math.floor(values.length/2);
    if(values.length % 2)
        return values[half];
    else
        return (values[half-1] + values[half]) / 2.0;
}

// read AIVDM messages from AIS receiver
var rl = readline.createInterface({
  input: process.stdin,
  output: '/dev/null'
});


rl.on('line', function(aivdm) {
	var aisobject = new AisDecode(aivdm, session);
	var now = Date.now();

	// we are only interested in AIS messages that send a mmsi, a position and a speed
	if (!aisobject.valid || !aisobject.mmsi || !aisobject.sog || !aisobject.lat || !aisobject.lon) {
		return;
	}
	// we are ony interested in boats with a tourist permission (from https://www.waternet.nl/zakelijk/beroepsvaart-in-en-om-amsterdam/passagiersvaart/register-bedrijfsmatig-passagiersvervoer-te-water/, extended with MMSI for each boat)
	if (!boats[aisobject.mmsi]) {
		return;
	}
	// convert knots to km/h
	aisobject.sog = aisobject.sog * 1.852;
	// ignore ludicrus speeds
	if (aisobject.sog > 25) {
		return;
	}

	aisobject.pos = {longitude: aisobject.lon, latitude: aisobject.lat};
	// we are only interested in boats currently in the "Grachtengordel", see https://drive.google.com/open?id=14aUW4lumzLStP8yhCdgeHZYE0x0&usp=sharing, based on https://www.amsterdam.nl/publish/pages/799094/bijbehorende_kaart_vaarsnelheden_amsterdam.pdf
	if (!geolib.isPointInside(aisobject.pos, slowzoneams1) && !geolib.isPointInside(aisobject.pos, slowzoneams2)) {
		return;
	}

	var boathist = boats[aisobject.mmsi].lastn;
	// filter out entries that are too old
	boathist = boathist.filter(function(e) {
		return now - e.time < timelimit * 1000;
	});

	// push new entry
	boathist.unshift({aivdm: aivdm, aisobject: aisobject, time : now});
	boats[aisobject.mmsi].lastn = boathist;

	var speeds = [];
	var totaldist = 0;
	var lastpos = undefined;

	// compute geographic distance between subsequent position reports and collect reported speeds
	boathist.forEach(function(e) { 
		if (lastpos != undefined) {
			totaldist += geolib.getDistance(lastpos, e.aisobject.pos);
		}
		lastpos = e.aisobject.pos;
		speeds.push(e.aisobject.sog)
	});
	var totaltimes = (boathist[0].time - boathist[boathist.length - 1].time) / 1000;
	// total distance travelled according to position reports divided by our timestamp
	var kmhavg = 3.6 * (totaldist/totaltimes);
	// median of all self-reported speeds for fairness
	var kmhrep = median(speeds);

	// sanity check, if the reported speed from AIS and the computed speed from travelled distance diverge by too much, ignore.
	if (Math.abs(kmhavg - kmhrep) > speedchecklimit) {
		return;
	}

	// save for tweeting later
	if (boathist.length > minn && kmhrep > tweetcand.kmhrep) {
		tweetcand = {boat: clone(boats[aisobject.mmsi]), kmhrep : kmhrep, timestamp : now};
		
		//console.log(boats[aisobject.mmsi].name + " ("+aisobject.mmsi+")");
		//console.log("Median reported speed: " + kmhrep.toFixed(2));

		//console.log();
	}
});


// this function tweets the worst offender in the last time interval
setInterval(function() {

	if (tweetcand.kmhrep < 1 || tweetcand.kmhrep < (speedlimit + ignorediff)) {
		console.log("Skipping tweet because no candidates");
		return;
	}

	// copy since this could take a while
	var tweetobj = clone(tweetcand);
	tweetcand = {kmhrep: 0};

	// generate geojson to render map image
	var linestringcoords = [];
	datastr = "DATE_TIME_UTC\tAIS_MESSAGE\tMMSI\tPERMIT\tLATITUDE\tLONGITUDE\tSPEED_KMH\n";
	tweetobj.boat.lastn.forEach(function(e) { 
		linestringcoords.push([e.aisobject.lon, e.aisobject.lat]);
		datastr += new Date(e.time).toISOString() + "\t" + e.aivdm + "\t" + e.aisobject.mmsi + "\t" + tweetobj.boat.permit + "\t" + e.aisobject.lat  + "\t" + e.aisobject.lon + "\t" + e.aisobject.sog + "\n";
	});
	geojson = {"type": "Feature", "properties": {"stroke": "#ff0000", "stroke-width": 5}, "geometry": {"type": "LineString", "coordinates" : linestringcoords}};
	// link creating the map picture with mapbox static api
	var imgurl = "https://api.mapbox.com/v4/mapbox.streets/geojson(" + encodeURIComponent(JSON.stringify(geojson)) + ")/auto/1000x1000.png?access_token=" + config.mapbox_token;

	// marinetraffic link 
	var infourl = "http://www.marinetraffic.com/en/ais/details/ships/mmsi:"+tweetobj.boat.mmsi;

	// TODO: compute fine from https://www.waternet.nl/siteassets/zakelijk/bijlage-three-strikes-out-principe.pdf

	var company = "@" + tweetobj.boat.twitter;
	if (company == "@") {
		company = "#" + tweetobj.boat.company.replace(/ /g,'');
	}

	// the callback hell begins, first download map pic
	request({uri: imgurl}).pipe(fs.createWriteStream("map.png")).on('close', function() {
		// gist upload for data
		var filename = "ais-"+tweetobj.boat.mmsi+"-"+tweetobj.boat.lastn[0].time+".tsv";
		var data = {
		  "public": true,
		  "files": {}
		};
		data["files"][filename] = {"content" : datastr};

		// now upload AIS records to GitHub Gists
		var options = {uri: 'https://api.github.com/gists', method: 'POST', json: data,  headers: { 'User-Agent': 'Some node bot'}};
		request(options, function (error, response, body) {
		  if (!error) {
		    var gisturl = body.html_url;

		// construct tweet text
		var tweet = "'"+tweetobj.boat.name+"' vaart " + (tweetobj.kmhrep - speedlimit).toFixed(1) +" km/h te hard (data: "+gisturl+" "+infourl+") "+company+" @020centrum @toezichttewater";

		console.log(tweet);

		// upload map picture to Twitter
		T.post('media/upload', { media_data: fs.readFileSync("map.png", { encoding: 'base64' }) }, function (err, data, response) {
		    var mediaIdStr = data.media_id_string
		    var meta_params = { media_id: mediaIdStr}
		    // create media metadata
		    T.post('media/metadata/create', meta_params, function (err, data, response) {
		      if (!err) {
		        var params = { status: tweet, media_ids: [mediaIdStr]}
		        // finally post actual Tweet
		        T.post('statuses/update', params, function (err, data, response) {
		          if (err) console.log(err)
		        })
		      }
		    })
		  });
		  }
		});
	  });
}, 60 * 60 * 1000); 

