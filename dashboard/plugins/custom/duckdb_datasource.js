// DuckDB-WASM Generic Datasource Plugin for agent-freeboard
// Acts as a generic translation layer between HuggingFace Parquet files and dashboard widgets.
// Uses DuckDB-WASM to run SQL queries directly in the browser on remote parquet files.
// No backend needed — DuckDB-WASM fetches parquet via HTTP range requests and filters with SQL.
//
// Translation-layer pattern:
//   This datasource normalizes raw parquet rows into a stable, widget-friendly schema so that
//   any widget (text, chart, gauge) can consume the data without knowing about DuckDB or parquet.
//   The output schema is identical to hf_dataset_datasource.js — widgets work with either backend.
//
// Output schema (passed to updateCallback):
//   sensors:       { name → latest reading object }  — for text/gauge widgets
//   series:        { name → [{ts, tempc, hum, ...}] } — for chart widgets
//   sensor_names:  [name, ...] — for iteration without Object.keys()
//   sensor_count:  number — for stat widgets
//   date_label:   human-readable date filter label (e.g. "Last 3 days")
//   date_range:   {start, end} — raw YYYY-MM-DD strings
//   total_rows / filtered_rows — row counts
//   total_files / scanned_files — parquet file counts (transparency)
//   last_reading_ts / last_reading_relative — most recent reading info
//   engine: "duckdb-wasm" — identifies the backend
//
// Architecture:
//   1. Lists parquet files from HuggingFace API (main branch, not refs/convert/parquet)
//   2. Pre-filters files by date using the Unix epoch timestamp embedded in filenames
//   3. Registers only the relevant files in DuckDB-WASM via read_parquet([...])
//   4. Runs SQL with WHERE clause for precise date filtering on the _ts column
//   5. Groups results per sensor into the widget-friendly schema above
//
// Date-filter optimization:
//   Parquet filenames contain a Unix epoch timestamp (e.g. "1786981619.0110333.a2327e7f30.parquet").
//   This timestamp is the DLT load time — very close to the data timestamps inside the file.
//   By comparing the filename's date against the requested date range, we skip downloading
//   and scanning files that cannot contain relevant data. DuckDB then applies a precise
//   SQL WHERE clause on the _ts column for exact filtering within the selected files.
//
// Settings:
//   dataset:  HuggingFace dataset name (e.g. "maxerbox/temperature_digital_twin")
//   config:   Dataset config / directory name (e.g. "pvvx_sensors")
//   split:    Dataset split name (kept for compatibility, not used in file listing)
//   date_filter: "today", "YYYY-MM-DD", "range:N" (last N days incl. today), or "from:YYYY-MM-DD,to:YYYY-MM-DD"
//   refresh:  Refresh interval in seconds
(function () {
  // ─── DuckDB-WASM singleton ──────────────────────────────────────────────
  // Shared across all datasource instances — initialized once on first use.
  // DuckDB-WASM is loaded as an ESM module via dynamic import() from jsdelivr CDN.
  var _duckdbPromise = null;
  var DUCKDB_VERSION = "1.32.0";
  // Use jsdelivr's /+esm endpoint — it auto-bundles apache-arrow inline.
  // The raw dist/duckdb-browser.mjs has `import "apache-arrow"` as a bare specifier
  // which browsers cannot resolve without an import map. The /+esm endpoint
  // resolves and inlines all dependencies, avoiding the need for an import map.
  var DUCKDB_CDN =
    "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@" +
    DUCKDB_VERSION +
    "/+esm";

  function initDuckDB() {
    if (_duckdbPromise) return _duckdbPromise;

    _duckdbPromise = (async function () {
      // Dynamic ESM import from jsdelivr CDN
      var duckdb = await import(DUCKDB_CDN);

      // Select the best bundle for this browser (ehsm, mvp, or coi)
      // selectBundle() is ASYNC — it checks browser features (SIMD, threads, etc.)
      // Missing await was the root cause of bundle.mainWorker being undefined.
      var JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
      var bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);

      // Create worker from CDN URL via Blob (avoids CORS worker issues)
      var worker_url = URL.createObjectURL(
        new Blob(['importScripts("' + bundle.mainWorker + '");'], {
          type: "text/javascript",
        }),
      );

      var worker = new Worker(worker_url);
      var logger = new duckdb.ConsoleLogger();
      var db = new duckdb.AsyncDuckDB(logger, worker);

      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      URL.revokeObjectURL(worker_url);

      // Connect and set up httpfs for remote parquet access
      var conn = await db.connect();

      // DuckDB-WASM has httpfs built-in (JS implementation), but we try to
      // load it explicitly in case the build requires it.
      try {
        await conn.query("LOAD httpfs;");
      } catch (e) {
        // httpfs is built-in in most WASM builds — ignore
      }

      return { db: db, conn: conn };
    })();

    return _duckdbPromise;
  }

  // ─── Date helpers ───────────────────────────────────────────────────────
  function todayStr() {
    var d = new Date();
    var mm = String(d.getMonth() + 1).padStart(2, "0");
    var dd = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + mm + "-" + dd;
  }

  function dateOffset(days) {
    var d = new Date();
    d.setDate(d.getDate() + days);
    var mm = String(d.getMonth() + 1).padStart(2, "0");
    var dd = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + mm + "-" + dd;
  }

  // Convert YYYY-MM-DD to Unix epoch seconds (UTC midnight)
  function dateToEpochSecs(dateStr) {
    return Math.floor(Date.parse(dateStr + "T00:00:00Z") / 1000);
  }

  // Parse date_filter setting and return {start, end} as YYYY-MM-DD strings
  // Supports: "today", "YYYY-MM-DD", "range:N", "from:YYYY-MM-DD,to:YYYY-MM-DD"
  function parseDateRange(dateFilter) {
    var df = dateFilter || "today";

    if (df === "today" || df === "") {
      var t = todayStr();
      return { start: t, end: t };
    }

    if (String(df).indexOf("range:") === 0) {
      var days = parseInt(String(df).split(":")[1], 10);
      if (isNaN(days) || days < 1) days = 7;
      return { start: dateOffset(-(days - 1)), end: todayStr() };
    }

    if (String(df).indexOf("from:") === 0) {
      // Format: from:YYYY-MM-DD,to:YYYY-MM-DD
      var parts = String(df).split(",");
      var fromPart = parts[0].replace("from:", "").trim();
      var toPart =
        parts.length > 1 ? parts[1].replace("to:", "").trim() : fromPart;
      return { start: fromPart, end: toPart };
    }

    // Single day: YYYY-MM-DD
    return { start: df, end: df };
  }

  // Human-readable label for the current date filter
  function dateFilterLabel(dateFilter) {
    var df = dateFilter || "today";
    if (df === "today" || df === "") return "Today";
    if (String(df).indexOf("range:") === 0) {
      var days = parseInt(String(df).split(":")[1], 10);
      return "Last " + days + " days";
    }
    if (String(df).indexOf("from:") === 0) {
      var r = parseDateRange(df);
      if (r.start === r.end) return r.start;
      return r.start + " → " + r.end;
    }
    return df;
  }

  // ─── Parquet file discovery + date-based pre-filtering ──────────────────

  // Step 1: List parquet files from HuggingFace API (main branch)
  // Returns array of {filename, size, epochSecs}
  // We use the HF tree API on the main branch because the /parquet endpoint
  // (refs/convert/parquet) is currently broken for this dataset.
  function fetchParquetFiles(dataset, config) {
    var url =
      "https://huggingface.co/api/datasets/" +
      dataset +
      "/tree/main/" +
      encodeURIComponent(config);

    return new Promise(function (resolve, reject) {
      $.ajax({
        url: url,
        dataType: "json",
        type: "GET",
        success: function (items) {
          var files = [];
          (items || []).forEach(function (item) {
            if (
              item.type === "file" &&
              String(item.path).endsWith(".parquet")
            ) {
              // Extract Unix epoch seconds from filename
              // Format: "1786981619.0110333.a2327e7f30.parquet"
              var basename = item.path.split("/").pop();
              var epochStr = basename.split(".")[0];
              var epochSecs = parseInt(epochStr, 10);

              files.push({
                filename: basename,
                path: item.path,
                size: item.size,
                epochSecs: isNaN(epochSecs) ? null : epochSecs,
              });
            }
          });
          // Sort by epoch ascending (oldest first)
          files.sort(function (a, b) {
            return (a.epochSecs || 0) - (b.epochSecs || 0);
          });
          resolve(files);
        },
        error: function (xhr, status, error) {
          reject(error);
        },
      });
    });
  }

  // Step 2: Pre-filter files by date using the filename's embedded epoch timestamp
  // The filename epoch is the DLT load time — data inside is always at or just
  // before that timestamp. So if the filename's DATE is within [start, end],
  // the file may contain relevant data.
  //
  // We also include files from the day before start as a safety margin, since
  // a file loaded just after midnight could contain data from the previous day.
  function filterFilesByDate(files, dateRange) {
    var startEpoch = dateToEpochSecs(dateRange.start);
    var endEpoch = dateToEpochSecs(dateRange.end) + 86400; // end of day (23:59:59)

    // Safety margin: include files from 1 day before start
    var marginEpoch = startEpoch - 86400;

    var filtered = files.filter(function (f) {
      if (f.epochSecs === null) return true; // keep files we can't parse
      // File's load timestamp must be after the margin and before end of end-date
      return f.epochSecs >= marginEpoch && f.epochSecs <= endEpoch;
    });

    return filtered;
  }

  // Build the resolve URL for a parquet file on the main branch
  function buildParquetUrl(dataset, path) {
    return (
      "https://huggingface.co/datasets/" + dataset + "/resolve/main/" + path
    );
  }

  // ─── Datasource plugin ──────────────────────────────────────────────────
  var duckdbDatasource = function (settings, updateCallback) {
    var self = this;
    var updateTimer = null;
    var currentSettings = settings;
    var cachedFiles = null; // cache file listing between refreshes
    var fileCacheTime = 0;
    var FILE_CACHE_TTL = 300000; // re-list files every 5 minutes

    function updateRefresh(refreshTime) {
      if (updateTimer) clearInterval(updateTimer);
      updateTimer = setInterval(function () {
        self.updateNow();
      }, refreshTime * 1000);
    }

    updateRefresh(currentSettings.refresh);

    // Step 3: Query filtered parquet files via DuckDB-WASM with SQL date filtering
    async function queryParquetData(parquetUrls, dateRange) {
      var duckdbCtx = await initDuckDB();
      var conn = duckdbCtx.conn;

      if (parquetUrls.length === 0) {
        return [];
      }

      // Build the SQL query
      // DuckDB can read multiple parquet files via read_parquet([url1, url2, ...])
      // We filter by date on the _ts column (timestamp type) for precise filtering
      var urlsSQL =
        "[" +
        parquetUrls
          .map(function (u) {
            return "'" + u + "'";
          })
          .join(", ") +
        "]";

      // Build WHERE clause for date range
      // _ts is timestamp[us, tz=UTC], we cast to date for comparison
      var whereClause =
        "WHERE CAST(_ts AS DATE) >= CAST('" +
        dateRange.start +
        "' AS DATE)" +
        " AND CAST(_ts AS DATE) <= CAST('" +
        dateRange.end +
        "' AS DATE)";

      // Query all rows filtered by date, ordered by _ts
      var sql =
        "SELECT * FROM read_parquet(" +
        urlsSQL +
        ") " +
        whereClause +
        " ORDER BY _ts ASC";

      var result = await conn.query(sql);

      // Convert Arrow table to array of objects
      var rows = [];
      if (result && result.numRows > 0) {
        rows = result.toArray().map(function (row) {
          var obj = {};
          for (var key in row) {
            // Convert Arrow timestamps to ISO strings for consistency
            if (row[key] instanceof Date) {
              obj[key] = row[key].toISOString();
            } else if (
              row[key] &&
              typeof row[key] === "object" &&
              typeof row[key].toISOString === "function"
            ) {
              obj[key] = row[key].toISOString();
            } else {
              obj[key] = row[key];
            }
          }
          return obj;
        });
      }
      return rows;
    }

    // Step 4: Process raw rows into dashboard-ready result
    function processData(rows, dateRange, totalFiles, scannedFiles) {
      var sensorMap = {};
      var sensorNames = [];
      var sensorSeries = {};

      rows.forEach(function (row) {
        var name = row.name || "Unknown";
        if (!sensorMap[name]) {
          sensorMap[name] = row;
          sensorNames.push(name);
          sensorSeries[name] = [];
        }
        // Always keep latest reading
        var existingTs = sensorMap[name]._ts;
        if (!existingTs || row._ts > existingTs) {
          sensorMap[name] = row;
        }
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

      // Find the most recent reading across all sensors
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

      // Human-readable relative time
      var lastReadingRelative = "N/A";
      if (lastReadingTs) {
        try {
          if (window.timeago) {
            lastReadingRelative = window.timeago.format(lastReadingTs);
          } else {
            var diffMs = Date.now() - new Date(lastReadingTs).getTime();
            var diffMin = Math.round(diffMs / 60000);
            if (diffMin < 1) lastReadingRelative = "just now";
            else if (diffMin === 1) lastReadingRelative = "1 minute ago";
            else if (diffMin < 60)
              lastReadingRelative = diffMin + " minutes ago";
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

      return {
        date: dateFilterLabel(currentSettings.date_filter),
        date_range: dateRange,
        date_label: dateFilterLabel(currentSettings.date_filter),
        date_from: dateRange.start,
        date_to: dateRange.end,
        total_rows: rows.length,
        filtered_rows: rows.length,
        sensor_count: sensorNames.length,
        sensor_names: sensorNames,
        sensors: sensorMap,
        series: sensorSeries,
        last_reading_ts: lastReadingTs,
        last_reading_relative: lastReadingRelative,
        last_updated: new Date().toISOString(),
        total_files: totalFiles,
        scanned_files: scannedFiles,
        engine: "duckdb-wasm",
      };
    }

    // ─── Main update cycle ─────────────────────────────────────────────────
    this.updateNow = function () {
      var dataset =
        currentSettings.dataset || "maxerbox/temperature_digital_twin";
      var config = currentSettings.config || "pvvx_sensors";
      var dateRange = parseDateRange(currentSettings.date_filter);

      // Notify UI that a fetch is starting (contextual loading indicator)
      if (window.setLoadingStatus) {
        window.setLoadingStatus(
          "Fetching data from HuggingFace (DuckDB-WASM)...",
        );
      }

      // Use cached file list if fresh, otherwise re-fetch
      var filesPromise;
      var now = Date.now();
      if (cachedFiles && now - fileCacheTime < FILE_CACHE_TTL) {
        filesPromise = Promise.resolve(cachedFiles);
      } else {
        filesPromise = fetchParquetFiles(dataset, config).then(
          function (files) {
            cachedFiles = files;
            fileCacheTime = now;
            return files;
          },
        );
      }

      filesPromise
        .then(function (allFiles) {
          // Pre-filter files by date using filename epoch timestamps
          var relevantFiles = filterFilesByDate(allFiles, dateRange);
          var urls = relevantFiles.map(function (f) {
            return buildParquetUrl(dataset, f.path);
          });
          return queryParquetData(urls, dateRange).then(function (rows) {
            return {
              rows: rows,
              totalFiles: allFiles.length,
              scannedFiles: relevantFiles.length,
            };
          });
        })
        .then(function (result) {
          var processed = processData(
            result.rows,
            dateRange,
            result.totalFiles,
            result.scannedFiles,
          );
          updateCallback(processed);
          // Hide contextual loading indicator
          if (window.hideLoadingOverlay) window.hideLoadingOverlay();
          // Notify datepicker that fetch is done
          if (window._dsFetchDone) window._dsFetchDone();
        })
        .catch(function (err) {
          var errMsg = String(err && err.message ? err.message : err);
          console.error("[DuckDB Datasource] Error:", err);
          // Show error to the user via toast notification
          if (window.showToast) {
            window.showToast("DuckDB: " + errMsg, "error");
          }
          // Hide contextual loading indicator
          if (window.hideLoadingOverlay) window.hideLoadingOverlay();
          // Notify datepicker that fetch is done
          if (window._dsFetchDone) window._dsFetchDone();
          updateCallback({
            error: errMsg,
            sensors: [],
            series: {},
            sensor_count: 0,
            filtered_rows: 0,
            total_rows: 0,
            sensor_names: [],
            date: dateFilterLabel(currentSettings.date_filter),
            date_label: "Error: " + errMsg.substring(0, 60),
            date_from: dateRange.start,
            date_to: dateRange.end,
            last_reading_relative: "N/A",
            last_updated: new Date().toISOString(),
            engine: "duckdb-wasm",
          });
        });
    };

    this.onDispose = function () {
      clearInterval(updateTimer);
      updateTimer = null;
    };

    this.onSettingsChanged = function (newSettings) {
      currentSettings = newSettings;
      // Invalidate file cache when dataset/config changes
      cachedFiles = null;
      fileCacheTime = 0;
      updateRefresh(currentSettings.refresh);
      self.updateNow();
    };
  };

  freeboard.loadDatasourcePlugin({
    type_name: "DuckDB Parquet",
    display_name: "DuckDB Parquet (HuggingFace)",
    description:
      "Generic datasource that loads HuggingFace parquet files and runs SQL queries with DuckDB-WASM directly in the browser. " +
      "Acts as a translation layer between HuggingFace Parquet files and dashboard widgets. " +
      "Date filtering uses filename-based pre-filtering + SQL WHERE clause for optimal performance.",
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
          "'today' for today, 'YYYY-MM-DD' for a single day, 'range:N' for last N days (incl. today), " +
          "or 'from:YYYY-MM-DD,to:YYYY-MM-DD' for a custom range. Filtering is done via SQL on parquet files.",
        type: "text",
        default_value: "range:3",
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
      newInstanceCallback(new duckdbDatasource(settings, updateCallback));
    },
  });
})();
