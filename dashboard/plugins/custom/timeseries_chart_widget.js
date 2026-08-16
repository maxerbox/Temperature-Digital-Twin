// Time Series Chart Widget for agent-freeboard
// Uses Chart.js (loaded from CDN in index.html) to render multi-series time series
// Shows temperature or humidity over time, one line per sensor
(function () {
	var chartWidget = function (settings, containerElement) {
		var self = this;
		var currentSettings = settings;
		var container = $(containerElement);
		var canvas = null;
		var chart = null;
		var currentData = null;

		// Colors for sensor lines
		var COLORS = [
			"#FF6384", "#36A2EB", "#FFCE56", "#4BC0C0", "#9966FF",
			"#FF9F40", "#C9CBCF", "#7CB342", "#E91E63", "#00BCD4"
		];

		function createCanvas() {
			container.empty();
			var wrapper = $('<div style="width:100%;height:100%;position:relative;"></div>');
			canvas = $('<canvas></canvas>');
			wrapper.append(canvas);
			container.append(wrapper);
			container.css("overflow", "hidden");
		}

		function buildChart(data) {
			if (!canvas || !data) return;
			if (chart) {
				chart.destroy();
				chart = null;
			}

			var metric = currentSettings.metric || "tempc";
			var metricLabel = metric === "tempc" ? "Temperature (°C)" :
				metric === "hum" ? "Humidity (%)" :
				metric === "batt" ? "Battery (%)" :
				metric === "volt" ? "Voltage (V)" :
				metric === "rssi" ? "RSSI (dBm)" : metric;

			var series = data.series || {};
			var sensorNames = data.sensor_names || [];

			// Collect all unique timestamps across sensors (for x-axis)
			var allTs = {};
			sensorNames.forEach(function (name) {
				var s = series[name] || [];
				s.forEach(function (point) {
					allTs[point.ts] = true;
				});
			});
			var sortedTs = Object.keys(allTs).sort();

			// Build datasets per sensor
			var datasets = sensorNames.map(function (name, idx) {
				var s = series[name] || [];
				var pointMap = {};
				s.forEach(function (p) {
					var label = p.ts.substring(11, 19); // HH:MM:SS
					pointMap[p.ts] = { v: p[metric], label: label };
				});

				var dataPoints = sortedTs.map(function (ts) {
					if (pointMap[ts]) {
						return { x: ts.substring(11, 19), y: pointMap[ts].v };
					}
					return null;
				});

				return {
					label: name,
					data: dataPoints,
					borderColor: COLORS[idx % COLORS.length],
					backgroundColor: COLORS[idx % COLORS.length] + "33",
					fill: false,
					tension: 0.3,
					pointRadius: 2,
					pointHoverRadius: 5,
					spanGaps: true
				};
			});

			var ctx = canvas[0].getContext("2d");
			chart = new Chart(ctx, {
				type: "line",
				data: {
					labels: sortedTs.map(function (ts) { return ts.substring(11, 19); }),
					datasets: datasets
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					interaction: {
						mode: "index",
						intersect: false
					},
					plugins: {
						title: {
							display: true,
							text: currentSettings.title || metricLabel,
							color: "#e0e0e0",
							font: { size: 14 }
						},
						legend: {
							display: currentSettings.show_legend !== false,
							position: "bottom",
							labels: { color: "#e0e0e0", font: { size: 11 }, boxWidth: 12 }
						},
						tooltip: {
							mode: "index",
							intersect: false
						}
					},
					scales: {
						x: {
							title: { display: true, text: "Time", color: "#a0a0a0" },
							ticks: { color: "#a0a0a0", maxRotation: 45, font: { size: 10 } },
							grid: { color: "#333" }
						},
						y: {
							title: { display: true, text: metricLabel, color: "#a0a0a0" },
							ticks: { color: "#a0a0a0", font: { size: 10 } },
							grid: { color: "#333" }
						}
					}
				}
			});
		}

		function updateValue() {
			if (!currentSettings.data_source) return;
			try {
				var data = eval(currentSettings.data_source);
				if (data && data !== currentData) {
					currentData = data;
					buildChart(data);
				}
			} catch (e) {
				// data_source not ready yet
			}
		}

		this.render = function (containerElement) {
			container = $(containerElement);
			createCanvas();
			updateValue();
		};

		this.onSettingsChanged = function (newSettings) {
			currentSettings = newSettings;
			createCanvas();
			updateValue();
		};

		this.onSizeChanged = function () {
			if (chart) chart.resize();
		};

		this.onCalculatedValueChanged = function (settingName, newValue) {
			if (settingName === "data_source") {
				currentData = newValue;
				buildChart(newValue);
			}
		};

		this.onDispose = function () {
			if (chart) {
				chart.destroy();
				chart = null;
			}
		};

		this.getHeight = function () {
			return Number(currentSettings.height) || 4;
		};
	};

	freeboard.loadWidgetPlugin({
		type_name: "Time Series Chart",
		display_name: "Time Series Chart",
		description: "Multi-series time series line chart using Chart.js. Shows sensor data over time.",
		settings: [
			{
				name: "title",
				display_name: "Title",
				type: "text",
				default_value: "Temperature"
			},
			{
				name: "data_source",
				display_name: "Data Source",
				type: "calculated",
				description: "Reference to the HF dataset datasource, e.g. datasources[\"Sensors\"].data"
			},
			{
				name: "metric",
				display_name: "Metric",
				type: "option",
				options: [
					{ name: "Temperature (°C)", value: "tempc" },
					{ name: "Humidity (%)", value: "hum" },
					{ name: "Battery (%)", value: "batt" },
					{ name: "Voltage (V)", value: "volt" },
					{ name: "RSSI (dBm)", value: "rssi" }
				],
				default_value: "tempc"
			},
			{
				name: "show_legend",
				display_name: "Show Legend",
				type: "boolean",
				default_value: true
			},
			{
				name: "height",
				display_name: "Height (rows)",
				type: "number",
				default_value: 4
			}
		],
		newInstance: function (settings, newInstanceCallback) {
			newInstanceCallback(new chartWidget(settings));
		},
		maximum_size_x: 12,
		maximum_size_y: 8
	});
})();
