// Datasource Explorer Widget for agent-freeboard
// Uses JsonTree.js (https://github.com/williamtroup/JsonTree.js) — a zero-dependency
// MIT-licensed JSON tree viewer loaded via CDN in index.html.
//
// Renders an interactive, collapsible tree view of ANY datasource's JSON structure.
// Lets you browse objects/arrays, see types and values, expand/collapse all nodes,
// and copy values to clipboard. This makes datasource bindings discoverable —
// instead of hardcoding datasources["Sensors"].data, you can explore the actual
// structure live and see what paths are available.
(function () {
  var explorerWidget = function (settings) {
    var currentSettings = settings;
    var container = null;
    var currentData = null;
    var treeElementId = null; // JsonTree.js element ID
    var treeCounter = 0; // unique counter for element IDs

    // ─── Helpers ──────────────────────────────────────────────────────────

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    // Extract datasource name from the data_source setting
    function getDsName() {
      var src = currentSettings.data_source || "";
      var match = src.match(/datasources\["([^"]+)"\]/);
      return match ? match[1] : null;
    }

    // ─── Tree rendering (delegates to JsonTree.js) ────────────────────────

    function buildTree(data) {
      if (!container) return;
      container.empty();

      // Check that JsonTree.js is loaded
      if (typeof $jsontree === "undefined") {
        container.append(
          '<div style="color:#ff6b6b;font-size:12px;padding:12px;font-family:monospace;flex-shrink:0;">' +
            "JsonTree.js failed to load. Check your network connection and reload the page." +
            "</div>",
        );
        return;
      }

      var dsName = getDsName();

      // ── Header ──
      var header = $(
        '<div style="margin-bottom:6px;padding-bottom:6px;flex-shrink:0;' +
          'border-bottom:1px solid #333;font-size:11px;color:#888;">' +
          '<span style="color:#82b1ff;">📦 ' +
          escapeHtml(dsName || "datasource") +
          "</span>" +
          (data && data.error
            ? ' <span style="color:#ff6b6b;">⚠ error</span>'
            : "") +
          "</div>",
      );
      container.append(header);

      if (!data) {
        container.append(
          '<div style="color:#666;font-size:12px;padding:12px;flex-shrink:0;">No data yet. Waiting for datasource...</div>',
        );
        return;
      }

      // ── Toolbar: expand all / collapse all / copy all JSON ──
      var toolbar = $(
        '<div style="margin-bottom:6px;font-size:10px;flex-shrink:0;display:flex;gap:12px;align-items:center;">' +
          '<span class="ds-expand-all" style="cursor:pointer;color:#2196f3;">Expand all</span>' +
          '<span class="ds-collapse-all" style="cursor:pointer;color:#2196f3;">Collapse all</span>' +
          '<span class="ds-copy-json" style="cursor:pointer;color:#4caf50;">Copy JSON</span>' +
          "</div>",
      );
      container.append(toolbar);

      // ── Tree container ──
      treeCounter++;
      treeElementId = "ds-explorer-tree-" + treeCounter;
      var treeDiv = $(
        '<div id="' +
          treeElementId +
          '" style="flex:1;min-height:0;overflow:auto;"></div>',
      );
      container.append(treeDiv);

      // ── Render the tree via JsonTree.js ──
      try {
        $jsontree.render(treeDiv[0], {
          data: data,
          showObjectSizes: true,
          showStringQuotes: true,
          showCommas: false,
          sortPropertyNames: false,
          showAllAsClosed: false,
        });
      } catch (e) {
        container.append(
          '<div style="color:#ff6b6b;font-size:12px;padding:8px;font-family:monospace;">' +
            "JsonTree render error: " +
            escapeHtml(String(e.message || e)) +
            "</div>",
        );
        return;
      }

      // ── Wire up toolbar buttons ──
      toolbar.find(".ds-expand-all").on("click", function () {
        if (treeElementId) $jsontree.openAll(treeElementId);
      });

      toolbar.find(".ds-collapse-all").on("click", function () {
        if (treeElementId) $jsontree.closeAll(treeElementId);
      });

      toolbar.find(".ds-copy-json").on("click", function () {
        var jsonStr;
        try {
          jsonStr = JSON.stringify(currentData, null, 2);
        } catch (e) {
          jsonStr = String(currentData);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(jsonStr).catch(function () {
            fallbackCopy(jsonStr);
          });
        } else {
          fallbackCopy(jsonStr);
        }
        var btn = $(this);
        var origText = btn.text();
        btn.text("✓ Copied!").css("color", "#4caf50");
        setTimeout(function () {
          btn.text(origText).css("color", "#4caf50");
        }, 1500);
      });
    }

    // Update existing tree data without rebuilding the scaffold (preserves
    // expand/collapse state). Falls back to a full rebuild if the tree
    // doesn't exist yet or setJson fails.
    function updateTreeData(data) {
      currentData = data;
      if (
        treeElementId &&
        typeof $jsontree !== "undefined" &&
        document.getElementById(treeElementId)
      ) {
        try {
          $jsontree.setJson(treeElementId, data);
          return;
        } catch (e) {
          // Fall through to full rebuild
        }
      }
      buildTree(data);
    }

    function fallbackCopy(text) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch (e) {
        // ignore
      }
      document.body.removeChild(ta);
    }

    function updateValue() {
      if (!currentSettings.data_source) return;
      try {
        var data = eval(currentSettings.data_source);
        if (data) {
          currentData = data;
          buildTree(data);
        }
      } catch (e) {
        // data_source not ready yet
      }
    }

    // ─── Widget lifecycle ─────────────────────────────────────────────────

    this.render = function (containerElement) {
      container = $(containerElement);
      container.empty();
      // Flex column layout so the tree fills remaining height after header/toolbar
      container.css({
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        height: "100%",
      });

      container.append(
        '<div style="color:#666;font-size:12px;padding:12px;font-family:monospace;flex-shrink:0;">Waiting for datasource data...</div>',
      );

      updateValue();
    };

    this.onSettingsChanged = function (newSettings) {
      currentSettings = newSettings;
      buildTree(currentData);
    };

    this.onCalculatedValueChanged = function (settingName, newValue) {
      if (settingName === "data_source") {
        updateTreeData(newValue);
      }
    };

    this.onDispose = function () {
      // Clean up JsonTree.js instance if it exists
      if (treeElementId && typeof $jsontree !== "undefined") {
        try {
          $jsontree.destroy(treeElementId);
        } catch (e) {
          // ignore
        }
      }
      container = null;
    };

    this.getHeight = function () {
      return Number(currentSettings.height) || 6;
    };
  };

  freeboard.loadWidgetPlugin({
    type_name: "Datasource Explorer",
    display_name: "Datasource Explorer",
    description:
      "Interactive tree view of any datasource's JSON structure (powered by JsonTree.js). " +
      "Browse objects, arrays, and values with expand/collapse, type coloring, and copy-to-clipboard. " +
      'Set Data Source to any datasource reference, e.g. datasources["Sensors"].',
    settings: [
      {
        name: "title",
        display_name: "Title",
        type: "text",
        default_value: "Datasource Explorer",
      },
      {
        name: "data_source",
        display_name: "Data Source",
        type: "calculated",
        description:
          'Reference to any datasource, e.g. datasources["Sensors"] or datasources["Sensors"].series',
      },
      {
        name: "height",
        display_name: "Height (rows)",
        type: "number",
        default_value: 6,
      },
    ],
    newInstance: function (settings, newInstanceCallback) {
      newInstanceCallback(new explorerWidget(settings));
    },
    maximum_size_x: 12,
    maximum_size_y: 12,
  });
})();
