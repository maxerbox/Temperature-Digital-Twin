// Date Picker Widget for agent-freeboard
// Shows a date input + quick buttons that update the datasource's date_filter
// and trigger a refresh
(function () {
	var datePickerWidget = function (settings) {
		var self = this;
		var currentSettings = settings;
		var containerEl = null;
		var dateInput = null;

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

			var wrapper = $('<div style="padding:10px;text-align:center;"></div>');

			// Title
			wrapper.append('<h3 style="color:#e0e0e0;margin-bottom:10px;">' +
				(currentSettings.title || "Select Date") + '</h3>');

			// Quick buttons row
			var btnRow = $('<div style="margin-bottom:10px;"></div>');
			var todayBtn = $('<button class="date-btn" data-date="today">Today</button>');
			var yestBtn = $('<button class="date-btn" data-date="' + dateOffset(-1) + '">Yesterday</button>');
			var prevWeekBtn = $('<button class="date-btn" data-date="' + dateOffset(-7) + '">-7 days</button>');
			btnRow.append(todayBtn, yestBtn, prevWeekBtn);
			wrapper.append(btnRow);

			// Date input
			var inputWrapper = $('<div style="margin-top:5px;"></div>');
			dateInput = $('<input type="date" id="dp-' + Math.random().toString(36).substr(2, 9) +
				'" style="padding:8px 12px;font-size:16px;background:#2a2a2a;color:#e0e0e0;border:1px solid #555;border-radius:4px;cursor:pointer;">');

			// Set initial value
			var initialDate = currentSettings.initial_date || "today";
			if (initialDate === "today" || !initialDate) {
				dateInput.val(todayStr());
			} else {
				dateInput.val(initialDate);
			}

			inputWrapper.append(dateInput);
			wrapper.append(inputWrapper);

			// Status text
			var status = $('<div id="dp-status" style="margin-top:8px;color:#888;font-size:12px;">Ready</div>');
			wrapper.append(status);

			containerEl.append(wrapper);

			// Add styles for buttons
			freeboard.addStyle('.date-btn',
				'background:#333;color:#e0e0e0;border:1px solid #555;padding:6px 14px;' +
				'margin:0 4px;border-radius:4px;cursor:pointer;font-size:13px;transition:background 0.2s;');
			freeboard.addStyle('.date-btn:hover', 'background:#444;');
			freeboard.addStyle('.date-btn.active', 'background:#2196F3;border-color:#2196F3;');

			// Date input change handler
			dateInput.on("change", function () {
				var selectedDate = $(this).val();
				status.text("Filtering for " + selectedDate + "...");
				self.updateDatasource(selectedDate);
			});

			// Quick button handlers
			btnRow.find("button").on("click", function () {
				var date = $(this).data("date");
				btnRow.find("button").removeClass("active");
				$(this).addClass("active");
				if (date === "today") {
					dateInput.val(todayStr());
					status.text("Filtering for today...");
					self.updateDatasource("today");
				} else {
					dateInput.val(date);
					status.text("Filtering for " + date + "...");
					self.updateDatasource(date);
				}
			});

			// Trigger initial load
			var initialVal = dateInput.val();
			if (initialVal) {
				status.text("Loading " + initialVal + "...");
				self.updateDatasource(initialVal);
			}
		};

		this.updateDatasource = function (dateStr) {
			var dsName = currentSettings.datasource_name;
			if (!dsName) return;

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
			return 2;
		};
	};

	freeboard.loadWidgetPlugin({
		type_name: "Date Picker",
		display_name: "Date Picker",
		description: "Date input with quick buttons that updates a datasource's date filter and triggers refresh.",
		settings: [
			{
				name: "title",
				display_name: "Title",
				type: "text",
				default_value: "Select Date"
			},
			{
				name: "datasource_name",
				display_name: "Datasource Name",
				type: "text",
				description: "Exact name of the HF Dataset Viewer datasource to update",
				default_value: "Sensors"
			},
			{
				name: "initial_date",
				display_name: "Initial Date",
				type: "text",
				description: "YYYY-MM-DD or 'today'",
				default_value: "today"
			}
		],
		newInstance: function (settings, newInstanceCallback) {
			newInstanceCallback(new datePickerWidget(settings));
		}
	});
})();
