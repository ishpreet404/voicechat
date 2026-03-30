module.exports = (req, res) => {
	res.setHeader("Cache-Control", "no-store");
	res.status(200).json({
		socketServerUrl: process.env.SIGNAL_SERVER_URL || "",
	});
};
