// Date Picker Widget for agent-freeboard
// Shows quick range buttons + from/to date inputs that update a datasource's date_filter
// and trigger a refresh.
//
// Quick buttons filter a RANGE of last N days (including today):
//   Today, -2d, -3d, -7d, -14d, -30d
//
// From/To date pickers allow custom range selection.
(function () {
  var datePickerWidget = function (settings) {
    var self = this;
    var currentSettings = settings;
    var containerEl = null;
    var fromInput = null;
    var toInput = null;

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

    this.render = function (containerElement) {
      containerEl = $(containerElement);
      containerEl.empty();

      var wrapper = $('<div style="padding:8px;text-align:center;"></div>');

      // Title
      wrapper.append(
        '<h3 style="color:#e0e0e0;margin-bottom:6px;font-size:14px;">' +
          (currentSettings.title || "Select Date Range") +
          "</h3>",
      );

      // Quick range buttons (3 columns) - each filters a RANGE of last N days (including today)
      var btnRow = $(
        '<div style="margin-bottom:6px;display:grid;grid-template-columns:repeat(3,1fr);gap:3px;"></div>',
      );
      var buttons = [
        { label: "Today", filter: "range:1" },
        { label: "2 days", filter: "range:2" },
        { label: "3 days", filter: "range:3" },
        { label: "7 days", filter: "range:7" },
        { label: "14 days", filter: "range:14" },
        { label: "30 days", filter: "range:30" },
      ];
      buttons.forEach(function (btn) {
        var $b = $(
          '<button class="date-btn" data-filter="' +
            btn.filter +
            '">' +
            btn.label +
            "</button>",
        );
        btnRow.append($b);
      });
      wrapper.append(btnRow);

      // From / To date inputs for custom range
      var rangeRow = $(
        '<div style="display:flex;gap:4px;align-items:center;margin-bottom:4px;"></div>',
      );
      rangeRow.append(
        '<span style="color:#999;font-size:11px;flex-shrink:0;">From</span>',
      );
      fromInput = $(
        '<input type="date" style="flex:1;min-width:0;padding:4px 6px;font-size:12px;background:#2a2a2a;color:#e0e0e0;border:1px solid #555;border-radius:3px;cursor:pointer;" />',
      );
      rangeRow.append(fromInput);
      rangeRow.append(
        '<span style="color:#999;font-size:11px;flex-shrink:0;">To</span>',
      );
      toInput = $(
        '<input type="date" style="flex:1;min-width:0;padding:4px 6px;font-size:12px;background:#2a2a2a;color:#e0e0e0;border:1px solid #555;border-radius:3px;cursor:pointer;" />',
      );
      rangeRow.append(toInput);
      wrapper.append(rangeRow);

      // Apply button for custom range
      var applyBtn = $(
        '<button class="date-btn" style="width:100%;margin-bottom:4px;">Apply Custom Range</button>',
      );
      wrapper.append(applyBtn);

      // Status / active filter display
      var status = $(
        '<div id="dp-status" style="margin-top:4px;color:#888;font-size:11px;line-height:1.4;">Ready</div>',
      );
      wrapper.append(status);

      containerEl.append(wrapper);

      // Add styles for buttons
      freeboard.addStyle(
        ".date-btn",
        "background:#333;color:#e0e0e0;border:1px solid #555;padding:5px 4px;" +
          "border-radius:3px;cursor:pointer;font-size:11px;text-align:center;" +
          "transition:background 0.2s;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
          "line-height:1.4;",
      );
      freeboard.addStyle(".date-btn:hover", "background:#444;");
      freeboard.addStyle(
        ".date-btn.active",
        "background:#2196F3;border-color:#2196F3;",
      );

      // Set initial from/to values based on current filter
      function syncInputsFromFilter(filter) {
        if (!filter || filter === "today" || filter === "") {
          fromInput.val(todayStr());
          toInput.val(todayStr());
        } else if (String(filter).indexOf("range:") === 0) {
          var days = parseInt(String(filter).split(":")[1], 10);
          fromInput.val(dateOffset(-(days - 1)));
          toInput.val(todayStr());
        } else if (String(filter).indexOf("from:") === 0) {
          var parts = String(filter).split(",");
          var fromPart = parts[0].replace("from:", "").trim();
          var toPart = parts.length > 1 ? parts[1].replace("to:", "").trim() : fromPart;
          fromInput.val(fromPart);
          toInput.val(toPart);
        } else {
          fromInput.val(filter);
          toInput.val(filter);
        }
      }

      syncInputsFromFilter(currentSettings.initial_date || "range:3");

      // Quick button click: all buttons are ranges (last N days including today)
      btnRow.find("button").on("click", function () {
        var filter = $(this).data("filter");
        var $btn = $(this);
        btnRow.find("button").removeClass("active");
        $btn.addClass("active");
        syncInputsFromFilter(filter);
        var days = parseInt(String(filter).split(":")[1], 10);
        if (days === 1) {
          status.text("Today");
        } else {
          status.text("Last " + days + " days (incl. today)");
        }
        // Show loading state on the button + status
        $btn.prop("disabled", true).css("opacity", "0.6");
        status.text("Fetching from HuggingFace...");
        if (window.setLoadingStatus) {
          window.setLoadingStatus(
            "Fetching " +
              (days === 1 ? "today" : "last " + days + " days") +
              " from HuggingFace (DuckDB-WASM)...",
          );
        }
        self.updateDatasource(filter);
      });

      // Apply custom range
      applyBtn.on("click", function () {
        var from = fromInput.val();
        var to = toInput.val();
        if (!from || !to) {
          status.text("Please select both From and To dates");
          return;
        }
        btnRow.find("button").removeClass("active");
        var filter = "from:" + from + ",to:" + to;
        if (from === to) {
          status.text(from);
        } else {
          status.text(from + " → " + to);
        }
        applyBtn.prop("disabled", true).css("opacity", "0.6");
        status.text("Fetching from HuggingFace...");
        if (window.setLoadingStatus) {
          window.setLoadingStatus(
            "Fetching " + from + " → " + to + " from HuggingFace (DuckDB-WASM)...",
          );
        }
        self.updateDatasource(filter);
      });

      // Trigger initial load
      var initialFilter = currentSettings.initial_date || "range:3";
      status.text("Loading...");
      self.updateDatasource(initialFilter);
    };

    this.updateDatasource = function (dateStr) {
      var dsName = currentSettings.datasource_name;
      if (!dsName) return;

      // Set up a one-shot callback so the datasource can re-enable buttons
      // when the fetch completes (success or error)
      window._dsFetchDone = function () {
        window._dsFetchDone = null;
        if (containerEl) {
          containerEl.find("button").prop("disabled", false).css("opacity", "");
        }
      };

      // Use freeboard's public API to update the datasource settings
      // setDatasourceSettings triggers onSettingsChanged internally which re-fetches
      var currentSettingsCopy = freeboard.getDatasourceSettings(dsName);
      if (currentSettingsCopy) {
        var newSettings = $.extend(true, {}, currentSettingsCopy);
        newSettings.date_filter = dateStr;
        freeboard.setDatasourceSettings(dsName, newSettings);
      }
    };

    this.onSettingsChanged = function (newSettings) {
      currentSettings = newSettings;
      if (containerEl) {
        this.render(containerEl);
      }
    };

    this.onCalculatedValueChanged = function (settingName, newValue) {
      // Could react to external changes here
    };

    this.onDispose = function () {};

    this.getHeight = function () {
      return 4;
    };
  };

  freeboard.loadWidgetPlugin({
    type_name: "Date Picker",
    display_name: "Date Picker",
    description:
      "Date range picker with quick range buttons and from/to date inputs. " +
      "Updates a datasource's date filter and triggers refresh.",
    settings: [
      {
        name: "title",
        display_name: "Title",
        type: "text",
        default_value: "Select Date Range",
      },
      {
        name: "datasource_name",
        display_name: "Datasource Name",
        type: "text",
        description: "Exact name of the DuckDB Parquet datasource to update",
        default_value: "Sensors",
      },
      {
        name: "initial_date",
        display_name: "Initial Date Filter",
        type: "text",
        description:
          "'range:N' (last N days incl. today, default range:3), or 'from:YYYY-MM-DD,to:YYYY-MM-DD '",
        default_value: "range:3",
      },
    ],
    newInstance: function (settings, newInstanceCallback) {
      newInstanceCallback(new datePickerWidget(settings));
    },
  });
})();
