// HF Dataset Viewer Datasource Plugin
// Fetches sensor data from HuggingFace Dataset Viewer API with pagination
// Filters by date (based on _ts field) and organizes data per sensor
(function () {
  var hfDatasource = function (settings, updateCallback) {
    var self = this;
    var updateTimer = null;
    var currentSettings = settings;

    // Default date = today in YYYY-MM-DD
    function defaultDate() {
      var d = new Date();
      var mm = String(d.getMonth() + 1).padStart(2, "0");
      var dd = String(d.getDate()).padStart(2, "0");
      return d.getFullYear() + "-" + mm + "-" + dd;
    }

    function updateRefresh(refreshTime) {
      if (updateTimer) clearInterval(updateTimer);
      updateTimer = setInterval(function () {
        self.updateNow();
      }, refreshTime * 1000);
    }

    updateRefresh(currentSettings.refresh);

    // Fetch all rows with pagination, then filter by date and organize
    this.updateNow = function () {
      var baseUrl = "https://datasets-server.huggingface.co/rows";
      var dataset =
        currentSettings.dataset || "maxerbox/temperature_digital_twin";
      var config = currentSettings.config || "pvvx_sensors";
      var split = currentSettings.split || "train";
      var batchSize = 100;
      var allRows = [];
      var offset = 0;
      var totalRows = null;

      function fetchBatch() {
        var url =
          baseUrl +
          "?dataset=" +
          encodeURIComponent(dataset) +
          "&config=" +
          encodeURIComponent(config) +
          "&split=" +
          encodeURIComponent(split) +
          "&offset=" +
          offset +
          "&length=" +
          batchSize;

        $.ajax({
          url: url,
          dataType: "json",
          type: "GET",
          success: function (data) {
            if (totalRows === null) {
              totalRows = data.num_rows_total || 0;
            }
            if (data.rows && data.rows.length > 0) {
              allRows = allRows.concat(data.rows);
              offset += data.rows.length;
            }

            // Continue if there are more rows
            if (offset < totalRows && data.rows && data.rows.length > 0) {
              fetchBatch();
            } else {
              processData(allRows);
            }
          },
          error: function (xhr, status, error) {
            // Return whatever we have so far on error
            if (allRows.length > 0) {
              processData(allRows);
            } else {
              updateCallback({ error: error, sensors: [], rows: [] });
            }
          },
        });
      }

      function processData(rows) {
        // Extract the actual row data
        var rawData = rows.map(function (r) {
          return r.row;
        });

        // Determine date filter
        var dateFilter = currentSettings.date_filter || defaultDate();
        var useTodayOnly = dateFilter === "today" || dateFilter === "";

        var filteredData;
        if (useTodayOnly) {
          var today = defaultDate();
          filteredData = rawData.filter(function (row) {
            if (!row._ts) return false;
            return row._ts.substring(0, 10) === today;
          });
        } else {
          filteredData = rawData.filter(function (row) {
            if (!row._ts) return false;
            return row._ts.substring(0, 10) === dateFilter;
          });
        }

        // Group by sensor name
        var sensorMap = {};
        var sensorNames = [];
        var sensorSeries = {}; // for time series: { name: [{ts, tempc, hum, batt, volt, rssi}] }

        filteredData.forEach(function (row) {
          var name = row.name || "Unknown";
          if (!sensorMap[name]) {
            sensorMap[name] = row;
            sensorNames.push(name);
            sensorSeries[name] = [];
          }
          // Always keep latest reading in sensorMap
          var existingTs = sensorMap[name]._ts;
          if (!existingTs || row._ts > existingTs) {
            sensorMap[name] = row;
          }
          // Push to time series array
          sensorSeries[name].push({
            ts: row._ts,
            tempc: row.tempc,
            tempf: row.tempf,
            hum: row.hum,
            batt: row.batt,
            volt: row.volt,
            rssi: row.rssi,
            mac: row.mac,
          });
        });

        // Sort each sensor's series by timestamp
        sensorNames.forEach(function (name) {
          sensorSeries[name].sort(function (a, b) {
            return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
          });
        });

        // Find the most recent sensor reading timestamp across all sensors
        var lastReadingTs = null;
        sensorNames.forEach(function (name) {
          var s = sensorSeries[name];
          if (s && s.length > 0) {
            var ts = s[s.length - 1].ts;
            if (!lastReadingTs || ts > lastReadingTs) {
              lastReadingTs = ts;
            }
          }
        });

        // Human-readable refresh time
        var now = new Date();
        var lastUpdatedDisplay =
          String(now.getHours()).padStart(2, "0") +
          ":" +
          String(now.getMinutes()).padStart(2, "0") +
          ":" +
          String(now.getSeconds()).padStart(2, "0");

        var result = {
          date: useTodayOnly ? defaultDate() : dateFilter,
          total_rows: rawData.length,
          filtered_rows: filteredData.length,
          sensor_count: sensorNames.length,
          sensor_names: sensorNames,
          sensors: sensorMap, // latest reading per sensor
          series: sensorSeries, // full time series per sensor
          last_reading_ts: lastReadingTs,
          last_updated: new Date().toISOString(),
          last_updated_display: lastUpdatedDisplay,
        };

        updateCallback(result);
      }

      fetchBatch();
    };

    this.onDispose = function () {
      clearInterval(updateTimer);
      updateTimer = null;
    };

    this.onSettingsChanged = function (newSettings) {
      currentSettings = newSettings;
      updateRefresh(currentSettings.refresh);
      self.updateNow();
    };
  };

  freeboard.loadDatasourcePlugin({
    type_name: "HF Dataset Viewer",
    display_name: "HF Dataset Viewer",
    description:
      "Fetches sensor data from HuggingFace Dataset Viewer API with date filtering and per-sensor organization.",
    settings: [
      {
        name: "dataset",
        display_name: "Dataset Name",
        type: "text",
        default_value: "maxerbox/temperature_digital_twin",
      },
      {
        name: "config",
        display_name: "Config",
        type: "text",
        default_value: "pvvx_sensors",
      },
      {
        name: "split",
        display_name: "Split",
        type: "text",
        default_value: "train",
      },
      {
        name: "date_filter",
        display_name: "Date Filter",
        description:
          "Filter data by this date (YYYY-MM-DD). Use 'today' for today's data. Leave blank for today.",
        type: "text",
        default_value: "today",
      },
      {
        name: "refresh",
        display_name: "Refresh Every",
        type: "number",
        suffix: "seconds",
        default_value: 60,
      },
    ],
    newInstance: function (settings, newInstanceCallback, updateCallback) {
      newInstanceCallback(new hfDatasource(settings, updateCallback));
    },
  });
})();
