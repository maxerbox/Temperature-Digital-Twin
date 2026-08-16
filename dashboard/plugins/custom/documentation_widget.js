// Documentation Widget for agent-freeboard
// Renders a small documentation card explaining how to use the dashboard
(function () {
  var documentationWidget = function (settings) {
    var self = this;
    var currentSettings = settings;
    var containerEl = null;

    this.render = function (containerElement) {
      containerEl = $(containerElement);
      containerEl.empty();

      var sections = [
        {
          icon: "📅",
          title: "Date Selection",
          body: "Use the Date Picker to choose a date range (Today, Last 3 days, Last 7 days, or a custom range). All sensor data updates automatically.",
        },
        {
          icon: "📊",
          title: "Sensor Charts",
          body: "Temperature and humidity charts show all sensors overlaid. Hover over the chart for exact values. Click a sensor name in the legend to toggle visibility.",
        },
        {
          icon: "🌲",
          title: "Datasource Explorer",
          body: "Browse the raw datasource as an interactive JSON tree. Expand/collapse nodes to inspect sensor readings, metadata, and series data.",
        },
        {
          icon: "⛶",
          title: "Fullscreen",
          body: "Click the ⛶ button in the bottom-right corner of any widget to expand it to fullscreen. Press Esc or click Close to exit.",
        },
        {
          icon: "🔄",
          title: "Auto-Refresh",
          body: "Sensor data refreshes automatically every 5 minutes from the DuckDB-WASM datasource. No page reload needed.",
        },
        {
          icon: "📝",
          title: "Edit Mode",
          body: "Click the wrench icon in the top bar to enter edit mode. Add, remove, rearrange, or configure widgets and panes.",
        },
      ];

      var wrapper = $(
        '<div style="padding:14px;height:100%;box-sizing:border-box;' +
          "background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);" +
          'overflow-y:auto;"></div>',
      );

      var heading = $(
        '<div style="color:#e0e0e0;font-size:15px;font-weight:700;margin-bottom:12px;' +
          'border-bottom:1px solid #333;padding-bottom:8px;">📋 Dashboard Guide</div>',
      );
      wrapper.append(heading);

      sections.forEach(function (s) {
        var item = $(
          '<div style="display:flex;gap:10px;margin-bottom:12px;align-items:flex-start;"></div>',
        );
        item.append(
          '<div style="font-size:18px;line-height:1.4;flex-shrink:0;">' +
            s.icon +
            "</div>",
        );
        var textCol = $('<div style="flex:1;min-width:0;"></div>');
        textCol.append(
          '<div style="color:#ccc;font-size:12px;font-weight:600;margin-bottom:2px;">' +
            s.title +
            "</div>",
        );
        textCol.append(
          '<div style="color:#888;font-size:11px;line-height:1.5;">' +
            s.body +
            "</div>",
        );
        item.append(textCol);
        wrapper.append(item);
      });

      containerEl.append(wrapper);
    };

    this.onSettingsChanged = function (newSettings) {
      currentSettings = newSettings;
      if (containerEl) {
        this.render(containerEl);
      }
    };

    this.onCalculatedValueChanged = function (settingName, newValue) {};

    this.onDispose = function () {};

    this.getHeight = function () {
      return Number(currentSettings.height) || 6;
    };
  };

  freeboard.loadWidgetPlugin({
    type_name: "Documentation",
    display_name: "Documentation",
    description:
      "A card with usage instructions for the dashboard.",
    settings: [
      {
        name: "title",
        display_name: "Title",
        type: "text",
        default_value: "How to Use",
      },
      {
        name: "height",
        display_name: "Height (rows)",
        type: "number",
        default_value: 6,
      },
    ],
    newInstance: function (settings, newInstanceCallback) {
      newInstanceCallback(new documentationWidget(settings));
    },
  });
})();
