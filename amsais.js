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
var ignorediff = 2;
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
var slowzoneams = [{longitude:4.8811912,latitude:52.3810482}, {longitude:4.8770285,latitude:52.3802362}, {longitude:4.8666429,latitude:52.3694944}, {longitude:4.8739815,latitude:52.3601128}, {longitude:4.8887443,latitude:52.3548184}, {longitude:4.9036789,latitude:52.3560504}, {longitude:4.8987437,latitude:52.3662713}, {longitude:4.9104166,latitude:52.3713547}, {longitude:4.9082708,latitude:52.3765685}, {longitude:4.8838949,latitude:52.3844798}, {longitude:4.8811912,latitude:52.3810482}];


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
	// we are only interested in boats currently in the "Grachtengordel", see https://drive.google.com/open?id=14aUW4lumzLStP8yhCdgeHZYE0x0&usp=sharing
	if (!geolib.isPointInside(aisobject.pos, slowzoneams)) {
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
	if (boathist.length > minn && kmhrep > (tweetcand.kmhrep + ignorediff)) {
		tweetcand = {boat: clone(boats[aisobject.mmsi]), kmhrep : kmhrep, timestamp : now};
		
		//console.log(boats[aisobject.mmsi].name + " ("+aisobject.mmsi+")");
		//console.log("Median reported speed: " + kmhrep.toFixed(2));

		//console.log();
	}
});


// this function tweets the worst offender in the last time interval
setInterval(function() {

	if (tweetcand.kmhrep < 1) {
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
		// TODO: Meaningful description
		var filename = "ais-"+tweetobj.boat.mmsi+"-"+tweetobj.boat.lastn[0].time+".tsv";
		var data = {
		  "description": "the description for this gist",
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

