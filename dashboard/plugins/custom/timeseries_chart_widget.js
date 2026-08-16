// Time Series Chart Widget for agent-freeboard
// Uses Apache ECharts (loaded from CDN in index.html) to render multi-series time series
// Shows temperature or humidity over time, one line per sensor
(function () {
  var chartWidget = function (settings, containerElement) {
    var self = this;
    var currentSettings = settings;
    var container = $(containerElement);
    var chartDiv = null;
    var chart = null;
    var currentData = null;

    // Colors for sensor lines
    var COLORS = [
      "#FF6384",
      "#36A2EB",
      "#FFCE56",
      "#4BC0C0",
      "#9966FF",
      "#FF9F40",
      "#C9CBCF",
      "#7CB342",
      "#E91E63",
      "#00BCD4",
    ];

    function createChartContainer() {
      container.empty();
      var heightRows = Number(currentSettings.height) || 4;
      var pixelHeight = Math.max(200, heightRows * 60);
      // ECharts renders into a <div> (not <canvas>), which is more resilient
      // to 0-height containers than Chart.js
      chartDiv = $(
        '<div style="width:100%;height:' + pixelHeight + 'px;"></div>',
      );
      container.append(chartDiv);
      container.css("overflow", "hidden");
    }

    function buildChart(data) {
      if (!chartDiv || !data) return;

      // Defer until the container div has non-zero dimensions
      var rafRetries = 0;
      function doBuild() {
        if (chartDiv[0].offsetWidth === 0 || chartDiv[0].offsetHeight === 0) {
          if (rafRetries < 10) {
            rafRetries++;
            requestAnimationFrame(doBuild);
            return;
          }
          return;
        }
        actuallyBuild();
      }

      function actuallyBuild() {
        if (chart) {
          chart.dispose();
          chart = null;
        }

        chart = echarts.init(chartDiv[0], "dark");

        var metric = currentSettings.metric || "tempc";
        var metricLabel =
          metric === "tempc"
            ? "Temperature (°C)"
            : metric === "hum"
              ? "Humidity (%)"
              : metric === "batt"
                ? "Battery (%)"
                : metric === "volt"
                  ? "Voltage (V)"
                  : metric === "rssi"
                    ? "RSSI (dBm)"
                    : metric;

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

        // X-axis labels: HH:MM:SS
        var xLabels = sortedTs.map(function (ts) {
          return ts.substring(11, 19);
        });

        // Build ECharts series per sensor
        var echartsSeries = sensorNames.map(function (name, idx) {
          var s = series[name] || [];
          var pointMap = {};
          s.forEach(function (p) {
            pointMap[p.ts] = p[metric];
          });

          var dataPoints = sortedTs.map(function (ts) {
            return pointMap.hasOwnProperty(ts) ? pointMap[ts] : null;
          });

          return {
            name: name,
            type: "line",
            data: dataPoints,
            smooth: true,
            symbol: "circle",
            symbolSize: 4,
            showSymbol: false,
            connectNulls: true,
            lineStyle: { width: 2 },
            itemStyle: { color: COLORS[idx % COLORS.length] },
          };
        });

        var option = {
          title: {
            text: currentSettings.title || metricLabel,
            left: "center",
            textStyle: { color: "#e0e0e0", fontSize: 14 },
          },
          tooltip: {
            trigger: "axis",
            axisPointer: { type: "cross" },
          },
          legend: {
            show: currentSettings.show_legend !== false,
            bottom: 0,
            type: "scroll",
            textStyle: { color: "#e0e0e0", fontSize: 11 },
            pageTextStyle: { color: "#e0e0e0" },
          },
          grid: {
            left: "8%",
            right: "5%",
            bottom: currentSettings.show_legend !== false ? "18%" : "10%",
            top: "15%",
            containLabel: true,
          },
          xAxis: {
            type: "category",
            data: xLabels,
            name: "Time",
            nameTextStyle: { color: "#a0a0a0" },
            axisLabel: {
              color: "#a0a0a0",
              fontSize: 10,
              rotate: 45,
            },
            axisLine: { lineStyle: { color: "#555" } },
            splitLine: { show: false },
          },
          yAxis: {
            type: "value",
            name: metricLabel,
            nameTextStyle: { color: "#a0a0a0" },
            axisLabel: { color: "#a0a0a0", fontSize: 10 },
            axisLine: { lineStyle: { color: "#555" } },
            splitLine: { lineStyle: { color: "#333" } },
          },
          dataZoom: [
            { type: "inside", start: 0, end: 100 },
            {
              type: "slider",
              start: 0,
              end: 100,
              height: 20,
              bottom: currentSettings.show_legend !== false ? "22%" : "14%",
            },
          ],
          series: echartsSeries,
        };

        chart.setOption(option);
      }

      doBuild();
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
      createChartContainer();
      updateValue();
    };

    this.onSettingsChanged = function (newSettings) {
      currentSettings = newSettings;
      createChartContainer();
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
        chart.dispose();
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
    description:
      "Multi-series time series line chart using Apache ECharts. Shows sensor data over time.",
    settings: [
      {
        name: "title",
        display_name: "Title",
        type: "text",
        default_value: "Temperature",
      },
      {
        name: "data_source",
        display_name: "Data Source",
        type: "calculated",
        description:
          'Reference to the HF dataset datasource, e.g. datasources["Sensors"].data',
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
          { name: "RSSI (dBm)", value: "rssi" },
        ],
        default_value: "tempc",
      },
      {
        name: "show_legend",
        display_name: "Show Legend",
        type: "boolean",
        default_value: true,
      },
      {
        name: "height",
        display_name: "Height (rows)",
        type: "number",
        default_value: 4,
      },
    ],
    newInstance: function (settings, newInstanceCallback) {
      newInstanceCallback(new chartWidget(settings));
    },
    maximum_size_x: 12,
    maximum_size_y: 8,
  });
})();
