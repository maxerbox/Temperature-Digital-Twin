// Link Card Widget for agent-freeboard
// Renders a clickable card with an emoji, title, and subtitle
// Used for external links (e.g. Hugging Face dataset source)
(function () {
  var linkCardWidget = function (settings) {
    var self = this;
    var currentSettings = settings;
    var containerEl = null;

    this.render = function (containerElement) {
      containerEl = $(containerElement);
      containerEl.empty();

      var url = currentSettings.url || "#";
      var emoji = currentSettings.emoji || "🔗";
      var title = currentSettings.title || "Source Dataset";
      var subtitle = currentSettings.subtitle || "";
      var openInNewTab = currentSettings.open_new_tab !== false;

      var targetAttr = openInNewTab ? ' target="_blank" rel="noopener noreferrer"' : "";

      var wrapper = $(
        '<a href="' + url + '"' + targetAttr +
        ' style="display:flex;align-items:center;gap:14px;padding:16px;text-decoration:none;' +
        'background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);' +
        'border:1px solid #333;border-radius:10px;height:100%;' +
        'box-sizing:border-box;transition:border-color 0.2s,transform 0.15s;' +
        'cursor:pointer;"></a>'
      );

      var emojiEl = $(
        '<div style="font-size:40px;line-height:1;flex-shrink:0;">' + emoji + "</div>"
      );

      var textWrapper = $('<div style="flex:1;min-width:0;"></div>');
      textWrapper.append(
        '<div style="color:#e0e0e0;font-size:15px;font-weight:600;margin-bottom:4px;' +
          'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
          title +
          "</div>"
      );
      if (subtitle) {
        textWrapper.append(
          '<div style="color:#888;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
            subtitle +
            "</div>"
        );
      }

      var arrowEl = $(
        '<div style="color:#555;font-size:18px;flex-shrink:0;">↗</div>'
      );

      wrapper.append(emojiEl, textWrapper, arrowEl);
      containerEl.append(wrapper);

      // Hover effects
      freeboard.addStyle(
        ".link-card-hover:hover",
        "border-color:#2196F3 !important;transform:translateY(-2px);",
      );
      wrapper.addClass("link-card-hover");
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
      return 2;
    };
  };

  freeboard.loadWidgetPlugin({
    type_name: "Link Card",
    display_name: "Link Card",
    description:
      "A clickable card with emoji, title, and subtitle for linking to external resources.",
    settings: [
      {
        name: "url",
        display_name: "URL",
        type: "text",
        description: "Link destination URL",
        default_value: "https://huggingface.co/datasets",
      },
      {
        name: "emoji",
        display_name: "Emoji",
        type: "text",
        description: "Emoji to display (e.g. 🤗)",
        default_value: "🤗",
      },
      {
        name: "title",
        display_name: "Title",
        type: "text",
        default_value: "Hugging Face Source Dataset",
      },
      {
        name: "subtitle",
        display_name: "Subtitle",
        type: "text",
        description: "Optional subtitle text",
        default_value: "maxerbox/temperature_digital_twin",
      },
      {
        name: "open_new_tab",
        display_name: "Open in New Tab",
        type: "boolean",
        default_value: true,
      },
    ],
    newInstance: function (settings, newInstanceCallback) {
      newInstanceCallback(new linkCardWidget(settings));
    },
  });
})();
