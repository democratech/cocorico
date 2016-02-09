var config = require('../../config.json');

var keystone = require('keystone');
var bcrypt = require('bcrypt');
var redis = require('redis');

var Text = keystone.list('Text'),
    Ballot = keystone.list('Ballot'),

    TextHelper = require('../../helpers/TextHelper'),
	BallotHelper = require('../../helpers/BallotHelper');

exports.resultPerDate = function(req, res)
{
    var textId = req.params.textId;

    Text.model.findById(textId)
        .exec(function(err, text)
        {
            if (err)
                return res.apiError('database error', err);

            if (!text)
                return res.status(404).send();

            if (!TextHelper.textIsReadable(text, req)
                || text.status != 'published')
                return res.status(403).send();

            Ballot.model.find({text : text})
                .exec(function(err, ballots)
                {
                    if (err)
                        return res.apiError('database error', err);

                    var result = {
                        yes     : {},
                        no      : {},
                        blank   : {}
                    };

                    for (var ballot of ballots)
                    {
                        var date = new Date(ballot.time).toISOString().slice(0, 10);

                        if (!(date in result[ballot.value]))
                            result[ballot.value][date] = 1;
                        else
                            result[ballot.value][date] += 1;
                    }

                    res.apiResponse({result : result});
                });
        });
}

exports.resultPerGender = function(req, res)
{
    var textId = req.params.textId;

    Text.model.findById(textId)
        .exec(function(err, text)
        {
            if (err)
                return res.apiError('database error', err);

            if (!text)
                return res.status(404).send();

            if (!TextHelper.textIsReadable(text, req)
                || text.status != 'published')
                return res.status(403).send();

            Ballot.model.find({text : text})
                .exec(function(err, ballots)
                {
                    if (err)
                        return res.apiError('database error', err);

                    var result = {
                        yes     : {male : 0, female : 0},
                        no      : {male : 0, female : 0},
                        blank   : {male : 0, female : 0}
                    };

                    for (var ballot of ballots)
                        if (ballot.voterGender)
                            result[ballot.value][ballot.voterGender] += 1;

                    res.apiResponse({result : result});
                });
        });
}

exports.resultPerAge = function(req, res)
{
    var textId = req.params.textId;

    Text.model.findById(textId)
        .exec(function(err, text)
        {
            if (err)
                return res.apiError('database error', err);

            if (!text)
                return res.status(404).send();

            if (!TextHelper.textIsReadable(text, req)
                || text.status != 'published')
                return res.status(403).send();

            Ballot.model.find({text : text})
                .exec(function(err, ballots)
                {
                    if (err)
                        return res.apiError('database error', err);

                    var result = {};
                    for (var ballot of ballots)
                        if (ballot.voterAge)
                        {
                            if (!(ballot.voterAge in result))
                                result[ballot.voterAge] = {
                                    yes     : 0,
                                    no      : 0,
                                    blank   : 0
                                };

                            result[ballot.voterAge][ballot.value] += 1;
                        }

                    res.apiResponse({result : result});
                });
        });
}

exports.result = function(req, res)
{
    var textId = req.params.textId;

    Text.model.findById(textId)
        .exec(function(err, text)
        {
            if (err)
                return res.apiError('database error', err);

            if (!text)
                return res.status(404).send();

            if (!TextHelper.textIsReadable(text, req)
                || text.status != 'published')
                return res.status(403).send();

            Ballot.model.find({text : text})
                .exec(function(err, ballots)
                {
                    if (err)
                        return res.apiError('database error', err);

                    var result = {
                        yes     : 0,
                        no      : 0,
                        blank   : 0
                    };

                    for (var ballot of ballots)
                        result[ballot.value] += 1;

                    res.apiResponse({result : result});
                });
        });
}

function pushBallotOnQueue(text, ballot, callback)
{
    if (!config.blockchain.voteEnabled)
        return callback(null, null);

    require('amqplib/callback_api').connect(
        'amqp://localhost',
        function(err, conn)
        {
            if (err != null)
                return callback(err, null);

            conn.createChannel(function(err, ch)
            {
                if (err != null)
                    return callback(err, null);

                var ballotObj = {
                    ballot : {
                        id                  : ballot.id,
                        voteContractAddress : text.voteContractAddress,
                        value               : ballot.value
                    }
                };

                ch.assertQueue('pending-votes');
                ch.sendToQueue(
                    'pending-votes',
                    new Buffer(JSON.stringify(ballotObj)),
                    { persistent : true }
                );

                callback(null, ballotObj);
            });
        }
    );
}

function vote(req, res, value)
{
    res.connection.setTimeout(0);

	Text.model.findById(req.params.id).exec(function(err, text)
	{
		if (err)
			return res.apiError('database error', err);
		if (!text)
			return res.apiError('not found');

		if (!TextHelper.textIsReadable(text, req))
			return res.status(403).send();

		BallotHelper.getByTextIdAndVoter(
			req.params.id,
			req.user.sub,
			function(err, ballot)
			{
				if (err)
					return res.apiError('database error', err);

				if (ballot)
					return res.status(403).apiResponse({
						error: 'user already voted'
					});

                var age = Math.floor(
                    (Date.now() - new Date(req.user.birthdate)) / 1000
                    / (60 * 60 * 24) / 365.25
                );

				ballot = Ballot.model({
					text: text,
					voter: bcrypt.hashSync(req.user.sub, 10),
					value: value,
                    voterAge : age,
                    voterGender : req.user.gender,
                    status: config.blockchain.voteEnabled ? 'pending' : 'complete'
				});

                ballot.save(function(err, result)
                {
                    if (err)
    					return res.apiError('database error', err);

                    // send the ballot to the vote queue
                    // if blockchain voting is disabled, it will simply call
                    // the callback immediately
                    pushBallotOnQueue(text, ballot, function(err, ballotMsg)
                    {
                        if (err)
                            return res.apiError('queue error', err);

                        return res.apiResponse({ ballot : ballot });
                    });
                });
			}
		);
	});
}

exports.voteYes = function(req, res)
{
	vote(req, res, 'yes');
}

exports.voteBlank = function(req, res)
{
	vote(req, res, 'blank');
}

exports.voteNo = function(req, res)
{
	vote(req, res, 'no');
}

exports.remove = function(req, res)
{
	Text.model.findById(req.params.id).exec(function(err, text)
	{
		if (err)
			return res.apiError('database error', err);
		if (!text)
			return res.apiError('not found');

		if (!TextHelper.textIsReadable(text, req))
			return res.status(403).send();

		BallotHelper.getByTextIdAndVoter(
			req.params.id,
			req.user.sub,
			function(err, ballot)
			{
				if (err)
					return res.apiError('database error', err);

				if (!ballot)
					return res.status(404).apiResponse({
						error: 'ballot does not exist'
					});

				Ballot.model.findById(ballot.id).remove(function(err)
				{
					var client = redis.createClient();
					var key = 'ballot/' + req.params.id + '/' + req.user.sub;

					if (err)
						return res.apiError('database error', err);

					client.on('connect', function()
					{
						client.del(key, function(err, reply)
						{
							if (err)
								console.log(err);

							return res.apiResponse({ ballot: 'removed' });
						});
					});
				});
			});
	});
}