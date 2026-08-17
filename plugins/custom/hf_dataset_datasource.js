// HF Dataset Viewer Datasource Plugin
// Fetches sensor data from HuggingFace Dataset Viewer /rows endpoint
// Performs client-side date filtering (the /filter endpoint's DuckDB index
// fails to build for this dataset, so we use /rows which works reliably)
// Supports single-day and date-range filters
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

    // Compute date N days before today (YYYY-MM-DD)
    function dateOffset(days) {
      var d = new Date();
      d.setDate(d.getDate() + days);
      var mm = String(d.getMonth() + 1).padStart(2, "0");
      var dd = String(d.getDate()).padStart(2, "0");
      return d.getFullYear() + "-" + mm + "-" + dd;
    }

    // Parse date_filter setting and return {start, end} as YYYY-MM-DD strings
    // Supports: "today", "YYYY-MM-DD", "range:N" (last N days including today)
    function parseDateRange(dateFilter) {
      var df = dateFilter || "today";

      if (df === "today" || df === "") {
        var today = defaultDate();
        return { start: today, end: today };
      }

      if (String(df).indexOf("range:") === 0) {
        var days = parseInt(String(df).split(":")[1], 10);
        if (isNaN(days) || days < 1) days = 7;
        var startDate = dateOffset(-(days - 1)); // N days ago (including today)
        var todayEnd = defaultDate();
        return { start: startDate, end: todayEnd };
      }

      // Single day: YYYY-MM-DD
      return { start: df, end: df };
    }

    // Client-side date filter: check if a row's _ts falls within [start, end]
    // _ts is an ISO 8601 string like "2025-08-17T14:30:00.000Z"
    function isInDateRange(tsStr, start, end) {
      if (!tsStr) return false;
      // Extract the date portion (first 10 chars: YYYY-MM-DD)
      var rowDate = String(tsStr).substring(0, 10);
      return rowDate >= start && rowDate <= end;
    }

    // Human-readable label for the current date filter
    function dateFilterLabel(dateFilter) {
      var df = dateFilter || "today";
      if (df === "today" || df === "") return "Today";
      if (String(df).indexOf("range:") === 0) {
        var days = parseInt(String(df).split(":")[1], 10);
        return "Last " + days + " days";
      }
      return df;
    }

    function updateRefresh(refreshTime) {
      if (updateTimer) clearInterval(updateTimer);
      updateTimer = setInterval(function () {
        self.updateNow();
      }, refreshTime * 1000);
    }

    updateRefresh(currentSettings.refresh);

    // Fetch all rows using /rows endpoint with pagination, then filter client-side
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

      var dateRange = parseDateRange(currentSettings.date_filter);

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
              if (window.showToast) {
                window.showToast("HF Dataset: " + error, "error");
              }
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

        // Client-side date filtering
        var filteredData = rawData.filter(function (row) {
          return isInDateRange(row._ts, dateRange.start, dateRange.end);
        });

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

        // Human-readable relative time for last sensor reading (e.g. "10 minutes ago")
        var lastReadingRelative = "N/A";
        if (lastReadingTs) {
          try {
            if (window.timeago) {
              lastReadingRelative = window.timeago.format(lastReadingTs);
            } else {
              // Fallback: simple relative formatting
              var diffMs = Date.now() - new Date(lastReadingTs).getTime();
              var diffMin = Math.round(diffMs / 60000);
              if (diffMin < 1) lastReadingRelative = "just now";
              else if (diffMin === 1) lastReadingRelative = "1 minute ago";
              else if (diffMin < 60) lastReadingRelative = diffMin + " minutes ago";
              else {
                var diffHr = Math.round(diffMin / 60);
                if (diffHr === 1) lastReadingRelative = "1 hour ago";
                else lastReadingRelative = diffHr + " hours ago";
              }
            }
          } catch (e) {
            lastReadingRelative = lastReadingTs;
          }
        }

        var result = {
          date: dateFilterLabel(currentSettings.date_filter),
          total_rows: rawData.length,
          filtered_rows: filteredData.length,
          sensor_count: sensorNames.length,
          sensor_names: sensorNames,
          sensors: sensorMap, // latest reading per sensor
          series: sensorSeries, // full time series per sensor
          last_reading_ts: lastReadingTs,
          last_reading_relative: lastReadingRelative,
          last_updated: new Date().toISOString(),
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
          "'today' for today, 'YYYY-MM-DD' for a single day, or 'range:N' for last N days (e.g. range:7). Filtering is done client-side after fetching from /rows.",
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
