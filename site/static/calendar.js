// Public calendar: no account data is fetched or rendered on the landing page.
(function () {
	'use strict';
	const calendar = document.getElementById('event-calendar');
	if (!calendar) return;
	const root = calendar;
	const heading = /** @type {HTMLElement} */ (document.getElementById('calendar-month'));
	const status = /** @type {HTMLElement} */ (document.getElementById('calendar-status'));
	const grid = /** @type {HTMLElement} */ (document.getElementById('calendar-grid'));
	const agenda = /** @type {HTMLElement} */ (document.getElementById('calendar-agenda'));
	const prev = /** @type {HTMLButtonElement} */ (document.getElementById('calendar-prev'));
	const next = /** @type {HTMLButtonElement} */ (document.getElementById('calendar-next'));
	const zone = 'America/Chicago';
	const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
	const current = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
	let month = new Date(current), generation = 0;
	const monthFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
	const timeFormat = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' });
	const dateFormat = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric' });

	/** @typedef {{url: string, title: string, start: string, end: string, date: string, summary: string, cancelled: boolean}} CalendarEvent */
	/** @param {string} tag @param {string} text @param {string} [className] */
	function node(tag, text, className) {
		const element = document.createElement(tag);
		element.textContent = text;
		if (className) element.className = className;
		return element;
	}

	/** @param {CalendarEvent} event @param {boolean} detailed */
	function eventLink(event, detailed) {
		const link = document.createElement('a');
		link.href = event.url;
		link.className = `calendar-event${event.cancelled ? ' calendar-event--cancelled' : ''}`;
		link.append(node('strong', event.title));
		const start = new Date(event.start), end = new Date(event.end);
		link.append(node('span', `${detailed ? `${dateFormat.format(start)} · ` : ''}${timeFormat.format(start)} – ${dateFormat.format(start) !== dateFormat.format(end) ? `${dateFormat.format(end)} ` : ''}${timeFormat.format(end)}`));
		link.append(node('small', event.summary));
		return link;
	}

	/** @param {CalendarEvent[]} events */
	function render(events) {
		grid.replaceChildren();
		agenda.replaceChildren();
		for (const day of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) grid.append(node('div', day, 'calendar-weekday'));
		for (let i = 0; i < month.getUTCDay(); i++) grid.append(node('div', '', 'calendar-blank'));
		const days = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
		for (let day = 1; day <= days; day++) {
			const date = `${month.toISOString().slice(0, 7)}-${String(day).padStart(2, '0')}`;
			const cell = node('div', '', `calendar-day${date === today ? ' calendar-day--today' : ''}`);
			cell.append(node('span', String(day), 'calendar-day-number'));
			// Include events continuing into this day, not only their first day.
			for (const event of events) {
				const lastDate = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(new Date(event.end).getTime() - 1));
				if (event.date <= date && lastDate >= date) cell.append(eventLink(event, false));
			}
			grid.append(cell);
		}
		for (const event of events) agenda.append(eventLink(event, true));
	}

	async function load() {
		const ticket = ++generation;
		const selected = month.toISOString().slice(0, 7);
		heading.textContent = monthFormat.format(month);
		const delta = (month.getUTCFullYear() - current.getUTCFullYear()) * 12 + month.getUTCMonth() - current.getUTCMonth();
		prev.disabled = delta <= -12;
		next.disabled = delta >= 24;
		status.textContent = 'Loading events…';
		grid.replaceChildren();
		agenda.replaceChildren();
		root.setAttribute('aria-busy', 'true');
		try {
			const response = await fetch(`/events/data?month=${selected}`, { credentials: 'omit' });
			if (!response.ok) throw new Error('Calendar unavailable');
			const data = /** @type {{month: string, events: CalendarEvent[]}} */ (await response.json());
			if (ticket !== generation) return;
			render(data.events);
			status.textContent = ''
		} catch {
			if (ticket === generation) status.textContent = 'Events couldn’t be loaded. Please try another month or open the event list below.';
		} finally {
			if (ticket === generation) root.setAttribute('aria-busy', 'false');
		}
	}
	/** @param {number} amount */
	function move(amount) {
		month = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + amount, 1));
		void load();
	}
	prev.addEventListener('click', () => move(-1));
	next.addEventListener('click', () => move(1));
	void load();
})();
