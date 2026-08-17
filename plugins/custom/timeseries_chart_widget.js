// Time Series Chart Widget for agent-freeboard
// Uses Apache ECharts (loaded from CDN in index.html) to render multi-series time series
// Shows temperature or humidity over time, one line per sensor
(function () {
  var chartWidget = function (settings, containerElement) {
    var self = this;
    var currentSettings = settings;
    var container = $(containerElement);
    var chartDiv = null; // outer wrapper (position:relative)
    var echartsDiv = null; // inner div that ECharts renders into
    var chart = null;
    var currentData = null;
    var fullscreenOverlay = null;
    var fullscreenChart = null;
    var fullscreenDiv = null;
    var lastOption = null;

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
        '<div style="width:100%;height:' +
          pixelHeight +
          'px;position:relative;"></div>',
      );
      container.append(chartDiv);
      container.css("overflow", "hidden");

      // Inner div for ECharts canvas — kept separate so the button stays on top
      echartsDiv = $('<div style="width:100%;height:100%;"></div>');
      chartDiv.append(echartsDiv);
    }

    function buildChart(data) {
      if (!chartDiv) return;

      // Handle error from datasource — show error message in the widget
      if (data && data.error) {
        if (chart) {
          chart.dispose();
          chart = null;
        }
        chartDiv.empty();
        chartDiv.append(
          '<div style="display:flex;align-items:center;justify-content:center;' +
            'width:100%;height:100%;flex-direction:column;color:#ff6b6b;">' +
            '<div style="font-size:28px;margin-bottom:8px;">⚠</div>' +
            '<div style="font-size:12px;padding:0 20px;text-align:center;max-width:90%;' +
            'font-family:monospace;word-break:break-word;">' +
            String(data.error).substring(0, 200) +
            "</div></div>",
        );
        return;
      }

      if (!data) return;

      // Defer until the container div has non-zero dimensions
      var rafRetries = 0;
      function doBuild() {
        if (
          !echartsDiv ||
          echartsDiv[0].offsetWidth === 0 ||
          echartsDiv[0].offsetHeight === 0
        ) {
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

        chart = echarts.init(echartsDiv[0], "dark");

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

        // Unit suffix for tooltip display
        var metricUnit =
          metric === "tempc"
            ? "°C"
            : metric === "hum"
              ? "%"
              : metric === "batt"
                ? "%"
                : metric === "volt"
                  ? "V"
                  : metric === "rssi"
                    ? "dBm"
                    : "";

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

        // Build a per-sensor sorted [ts, value] array for interpolation
        var sensorSortedData = {};
        sensorNames.forEach(function (name) {
          var s = (series[name] || []).slice().sort(function (a, b) {
            return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
          });
          sensorSortedData[name] = s.map(function (p) {
            return { ts: p.ts, val: p[metric] };
          });
        });

        // Linear interpolation: given a timestamp index, estimate the value
        // for a sensor that has no exact data point at that timestamp.
        // Also treats NaN (from DuckDB NULLs) as missing data.
        function interpolateValue(sensorName, tsIndex) {
          var ts = sortedTs[tsIndex];
          var pts = sensorSortedData[sensorName];
          if (!pts || pts.length === 0) return null;

          // Exact match (skip NaN values)
          for (var i = 0; i < pts.length; i++) {
            if (pts[i].ts === ts) {
              var v = pts[i].val;
              return (v === null || v === undefined || isNaN(v)) ? null : v;
            }
          }

          // Find surrounding points (skip NaN)
          var before = null;
          var after = null;
          for (var j = 0; j < pts.length; j++) {
            var pv = pts[j].val;
            var valid = pv !== null && pv !== undefined && !isNaN(pv);
            if (pts[j].ts < ts && valid) before = pts[j];
            if (pts[j].ts > ts && valid && !after) {
              after = pts[j];
              break;
            }
          }

          // Interpolate between before and after
          if (before && after) {
            var t0 = new Date(before.ts).getTime();
            var t1 = new Date(after.ts).getTime();
            var t = new Date(ts).getTime();
            if (t1 === t0) return before.val;
            var ratio = (t - t0) / (t1 - t0);
            return before.val + (after.val - before.val) * ratio;
          }

          // Hold last known value if only one side is available
          if (before) return before.val;
          if (after) return after.val;
          return null;
        }

        // Build ECharts series per sensor
        // Pre-interpolate: fill every timestamp slot with an interpolated
        // value so both the chart lines and the tooltip are continuous.
        // Sensors measure at different times, so without interpolation most
        // slots would be null and the tooltip would show "—".
        var echartsSeries = sensorNames.map(function (name, idx) {
          var dataPoints = sortedTs.map(function (ts, tsIndex) {
            return interpolateValue(name, tsIndex);
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
            appendToBody: true,
            formatter: function (params) {
              if (!params || params.length === 0) return "";
              var html =
                '<div style="font-weight:bold;margin-bottom:4px;">' +
                params[0].axisValueLabel +
                "</div>";
              var hoverIdx = params[0].dataIndex;
              // Build a quick lookup of params by series name
              var paramMap = {};
              params.forEach(function (p) {
                paramMap[p.seriesName] = p;
              });
              // Iterate ALL sensors so every sensor shows a value (interpolated)
              sensorNames.forEach(function (name, idx) {
                var p = paramMap[name];
                var val = p ? p.value : interpolateValue(name, hoverIdx);
                var color =
                  (echartsSeries[idx] && echartsSeries[idx].itemStyle &&
                    echartsSeries[idx].itemStyle.color) ||
                  COLORS[idx % COLORS.length];
                var marker =
                  '<span style="display:inline-block;margin-right:5px;' +
                  "border-radius:10px;width:10px;height:10px;" +
                  "background:" + color + ';"></span>';
                var display =
                  val !== null && val !== undefined && !isNaN(val)
                    ? Number(val).toFixed(1) + " " + metricUnit
                    : "—";
                html += marker + name + ": " + display + "<br/>";
              });
              return html;
            },
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
            axisLabel: {
              color: "#a0a0a0",
              fontSize: 10,
              formatter: function (val) {
                return val + " " + metricUnit;
              },
            },
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

        lastOption = option;
        chart.setOption(option);
      }

      doBuild();
    }

    this.toggleFullscreen = function () {
      if (fullscreenOverlay) {
        // Exit fullscreen
        if (fullscreenChart) {
          fullscreenChart.dispose();
          fullscreenChart = null;
        }
        fullscreenOverlay.remove();
        fullscreenOverlay = null;
        fullscreenDiv = null;
        // Resize the inline chart back to normal
        if (chart) chart.resize();
      } else {
        // Enter fullscreen
        fullscreenOverlay = $(
          '<div style="position:fixed;top:0;left:0;width:100vw;height:100vh;' +
            "background:rgba(0,0,0,0.95);z-index:99999;display:flex;" +
            'flex-direction:column;"></div>',
        );

        // Close button
        var closeBtn = $(
          '<button style="position:absolute;top:12px;right:16px;z-index:10;' +
            "background:rgba(255,255,255,0.1);border:1px solid #555;" +
            "border-radius:4px;color:#ccc;padding:6px 14px;font-size:16px;" +
            'cursor:pointer;">✕ Close</button>',
        );
        closeBtn.on("click", function () {
          self.toggleFullscreen();
        });

        fullscreenDiv = $(
          '<div style="flex:1;width:100%;margin-top:20px;"></div>',
        );

        fullscreenOverlay.append(closeBtn, fullscreenDiv);
        $(document.body).append(fullscreenOverlay);

        // Initialize ECharts in fullscreen div
        fullscreenChart = echarts.init(fullscreenDiv[0], "dark");
        if (lastOption) {
          fullscreenChart.setOption(lastOption);
        }

        // Handle Escape key
        var escHandler = function (e) {
          if (e.key === "Escape" && fullscreenOverlay) {
            self.toggleFullscreen();
          }
        };
        $(document).on("keydown.fschart", escHandler);
      }
    };

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
      if (fullscreenChart) {
        fullscreenChart.dispose();
        fullscreenChart = null;
      }
      if (fullscreenOverlay) {
        fullscreenOverlay.remove();
        fullscreenOverlay = null;
      }
      $(document).off("keydown.fschart");
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
