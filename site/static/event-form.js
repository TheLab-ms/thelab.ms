// Keep the three recurrence choices in sync with the selected local start date.
(function () {
	'use strict';
	const start = /** @type {HTMLInputElement | null} */ (document.getElementById('event-start'));
	const repeat = /** @type {HTMLSelectElement | null} */ (document.getElementById('event-repeat'));
	if (!start || !repeat) return;
	const input = start, select = repeat;
	const original = /** @type {HTMLInputElement | null} */ (input.form?.querySelector('[name="recurrence_start"]'));
	const ordinal = /** @type {HTMLInputElement | null} */ (input.form?.querySelector('[name="ordinal"]'));
	const weekdayFormat = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' });
	function update() {
		const dateText = input.value.slice(0, 10);
		if (!/^\d{4}-\d\d-\d\d$/.test(dateText)) return;
		const date = new Date(`${dateText}T12:00:00Z`);
		if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== dateText) return;
		const weekday = weekdayFormat.format(date), week = Math.ceil(date.getUTCDate() / 7);
		const position = original?.value.slice(0, 10) === dateText && ordinal ? Number(ordinal.value) : week === 5 ? -1 : week;
		const nth = position === -1 ? 'last' : ['first', 'second', 'third', 'fourth'][position - 1];
		for (const option of select.options) {
			if (option.value === 'weekly') option.textContent = `Every ${weekday}`;
			if (option.value === 'ordinal') option.textContent = `The ${nth} ${weekday} of every month`;
		}
	}
	input.addEventListener('input', update);
	input.addEventListener('change', update);
	update();
})();
